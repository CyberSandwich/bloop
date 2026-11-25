// Compound File Binary (.doc, .xls, .ppt) directory scan (DROP-12): names the storages that carry macros, embedded
// objects or encryption. Reads the header, the FAT sectors it needs and the directory chain; never a data stream.
//
// Limits: only what the directory shows. Legacy macros that live inside a stream (PowerPoint's VBA project record,
// Excel 4 macro sheets) and RC4 encryption flagged in a stream header are not seen here.
import { type Check, fail, OK } from "./formats.ts";
import type { RangeReader } from "./index.ts";

const HEADER_BYTES = 512;
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const MAX_REG_SECTOR = 0xfffffffa;
const FREE = 0xffffffff;
const DIR_ENTRY_BYTES = 128;
const HEADER_DIFAT_ENTRIES = 109;

/** Bounds: a real Office file stays far below each; a crafted one stops at them. */
export const CFB_LIMITS = { maxDirEntries: 4096, maxDifatSectors: 64, maxFatSectors: 4096 } as const;

const UNALLOCATED = 0;
const MACRO_NAMES = ["vba", "_vba_project_cur", "_vba_project", "macros", "projectwm"];
const OBJECT_NAMES = ["objectpool", "\x01ole10native"];
const ENCRYPTED_NAMES = ["encryptioninfo", "encryptedpackage", "\x06dataspaces"];

const bad = (reason: string) => fail("bad_structure", reason);
const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Directory names compare case-insensitively (MS-CFB 2.6.4). */
function verdictFor(names: readonly string[]): Check {
  const has = (set: readonly string[]) => names.some((n) => set.includes(n));
  if (has(MACRO_NAMES)) return fail("macro_content", "macro storage");
  if (has(OBJECT_NAMES)) return fail("macro_content", "embedded object");
  if (has(ENCRYPTED_NAMES)) return fail("bad_structure", "encrypted storage");
  return OK;
}

export async function scanCfb(r: RangeReader): Promise<Check> {
  const head = await r.read(0, HEADER_BYTES);
  if (head.length < HEADER_BYTES || !MAGIC.every((m, i) => head[i] === m))
    return fail("bad_type", "not a compound file");
  const hv = view(head);
  const major = u16(hv, 26);
  const shift = u16(hv, 30);
  if (u16(hv, 28) !== 0xfffe || !((major === 3 && shift === 9) || (major === 4 && shift === 12)))
    return bad("cfb header");
  const sectorSize = 1 << shift;
  const perSector = sectorSize / 4;
  const [fatCount, firstDir, firstDifat, difatCount] = [u32(hv, 44), u32(hv, 48), u32(hv, 68), u32(hv, 72)];
  if (fatCount === 0 || fatCount > CFB_LIMITS.maxFatSectors || difatCount > CFB_LIMITS.maxDifatSectors)
    return bad("cfb header");

  const sector = async (id: number): Promise<DataView | null> => {
    const offset = (id + 1) * sectorSize;
    if (id > MAX_REG_SECTOR || offset + sectorSize > r.size) return null;
    const bytes = await r.read(offset, sectorSize);
    return bytes.length === sectorSize ? view(bytes) : null;
  };

  const fatIds: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES; i++) fatIds.push(u32(hv, 76 + i * 4));
  const seenDifat = new Set<number>();
  for (let id = firstDifat, n = 0; id !== END_OF_CHAIN && id !== FREE; n++) {
    const s = n < difatCount && !seenDifat.has(id) ? await sector(id) : null;
    if (!s) return bad("cfb difat");
    seenDifat.add(id);
    for (let i = 0; i < perSector - 1; i++) fatIds.push(u32(s, i * 4));
    id = u32(s, (perSector - 1) * 4);
  }
  const fatSectors = fatIds.filter((id) => id !== FREE).slice(0, fatCount);
  if (fatSectors.length !== fatCount) return bad("cfb fat");

  const fatCache = new Map<number, DataView>();
  const next = async (id: number): Promise<number | null> => {
    const at = fatSectors[Math.floor(id / perSector)];
    if (at === undefined) return null;
    let s = fatCache.get(at);
    if (!s) {
      const read = await sector(at);
      if (!read) return null;
      s = read;
      fatCache.set(at, s);
    }
    return u32(s, (id % perSector) * 4);
  };

  const maxChain = Math.ceil((CFB_LIMITS.maxDirEntries * DIR_ENTRY_BYTES) / sectorSize);
  const names: string[] = [];
  const seen = new Set<number>();
  for (let id = firstDir; id !== END_OF_CHAIN; ) {
    if (seen.has(id) || seen.size >= maxChain) return bad("cfb directory chain");
    seen.add(id);
    const s = await sector(id);
    if (!s) return bad("cfb directory sector");
    for (let at = 0; at < sectorSize; at += DIR_ENTRY_BYTES) {
      const nameBytes = u16(s, at + 64);
      if (s.getUint8(at + 66) === UNALLOCATED) continue;
      if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0) return bad("cfb directory name");
      const chars = new Uint16Array((nameBytes - 2) / 2).map((_, i) => s.getUint16(at + i * 2, true));
      names.push(String.fromCharCode(...chars).toLowerCase());
    }
    const link = await next(id);
    if (link === null || (link > MAX_REG_SECTOR && link !== END_OF_CHAIN)) return bad("cfb fat chain");
    id = link;
  }
  return names.length === 0 ? bad("cfb empty directory") : verdictFor(names);
}
