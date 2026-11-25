// Zip structure reading from byte ranges: the end record and the central directory only. Nothing here
// inflates an entry; `dataStart` locates an entry's stored bytes for the read plan (read-plan.ts).
import type { DropError } from "../../../shared/protocol.ts";
import { type RangeReader, ZIP_LIMITS } from "./index.ts";

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
}
export type ZipRead = { ok: true; entries: ZipEntry[] } | { ok: false; error: DropError };

const refuse = (error: DropError = "bad_structure"): { ok: false; error: DropError } => ({ ok: false, error });
const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** How many trailing bytes can hold an end record. */
export const TAIL_BYTES = EOCD_SIZE + MAX_COMMENT;

/**
 * Index of a plausible end record in `tail`: the signature, with a comment length that reaches exactly the end
 * of the file. A signature that merely appears in the data does not qualify. -1 when there is none.
 */
export function findEndRecord(tail: Uint8Array): number {
  const v = view(tail);
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (u32(v, i) === EOCD_SIG && i + EOCD_SIZE + u16(v, i + 20) === tail.length) return i;
  }
  return -1;
}

const tailOf = (r: RangeReader) => r.read(Math.max(0, r.size - TAIL_BYTES), Math.min(r.size, TAIL_BYTES));

/** True when the end of the file carries a zip end record (a polyglot when the file claims to be a PDF). */
export async function hasEndRecord(r: RangeReader): Promise<boolean> {
  return findEndRecord(await tailOf(r)) !== -1;
}

/** Reads and bounds-checks the central directory. Zip64, multi-disk and encrypted entries are refused. */
export async function readCentralDirectory(r: RangeReader): Promise<ZipRead> {
  const tail = await tailOf(r);
  const at = findEndRecord(tail);
  if (at === -1) return refuse();
  const tv = view(tail);
  if (at >= 20 && u32(tv, at - 20) === EOCD64_LOCATOR_SIG) return refuse();
  const [disk, cdDisk, onDisk, total, cdSize, cdOffset] = [
    u16(tv, at + 4),
    u16(tv, at + 6),
    u16(tv, at + 8),
    u16(tv, at + 10),
    u32(tv, at + 12),
    u32(tv, at + 16),
  ];
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return refuse();
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return refuse();
  if (total === 0 || total > ZIP_LIMITS.maxEntries) return refuse();
  if (cdSize > ZIP_LIMITS.maxCentralDirectoryBytes) return refuse();
  const endRecordOffset = r.size - (tail.length - at);
  if (cdOffset + cdSize > endRecordOffset) return refuse();

  const cd = await r.read(cdOffset, cdSize);
  if (cd.length !== cdSize) return refuse();
  const cv = view(cd);
  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > cd.length || u32(cv, pos) !== CD_SIG) return refuse();
    const [flags, method, compressed, uncompressed] = [
      u16(cv, pos + 8),
      u16(cv, pos + 10),
      u32(cv, pos + 20),
      u32(cv, pos + 24),
    ];
    const [nameLen, extraLen, commentLen, localOffset] = [
      u16(cv, pos + 28),
      u16(cv, pos + 30),
      u16(cv, pos + 32),
      u32(cv, pos + 42),
    ];
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cd.length) return refuse();
    if (flags & 1 || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      return refuse();
    }
    if (localOffset + 30 > cdOffset) return refuse();
    entries.push({
      name: decoder.decode(cd.subarray(pos + 46, pos + 46 + nameLen)),
      method,
      compressed,
      uncompressed,
      localOffset,
    });
    pos = next;
  }
  return pos === cd.length ? { ok: true, entries } : refuse();
}

/** Declared-size caps (DROP-04): total, and the ratio of any sizeable entry. Declared sizes can lie; see the threat model. */
export function checkSizes(entries: readonly ZipEntry[]): DropError | null {
  let total = 0;
  for (const e of entries) {
    total += e.uncompressed;
    if (e.uncompressed >= ZIP_LIMITS.ratioFloorBytes) {
      if (e.compressed === 0 || e.uncompressed / e.compressed > ZIP_LIMITS.maxEntryRatio) return "bad_structure";
    }
  }
  return total > ZIP_LIMITS.maxTotalUncompressed ? "bad_structure" : null;
}

export const LOCAL_HEADER_BYTES = 30;

/** Where an entry's stored data starts, as an index into `bytes` holding its local header at `at`; null when none is there. */
export function dataStart(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + LOCAL_HEADER_BYTES > bytes.length) return null;
  const v = view(bytes);
  if (u32(v, at) !== LOCAL_SIG) return null;
  return at + LOCAL_HEADER_BYTES + u16(v, at + 26) + u16(v, at + 28);
}
