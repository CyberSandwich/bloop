// Streaming zip64 STORE writer for the library export: entries come from streams of unknown length, so each carries a
// data descriptor and zip64 sizes; the central directory and end records go to zip64 only when a count or an offset
// needs it. Memory is one central record per entry, never the data.
import { crc32 } from "../crc32.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const VERSION = 45;
const EXTRA_ZIP64 = 0x0001;
const STORE = 0;

type Field = [width: 2 | 4 | 8, value: number];
/** Little-endian fixed-width fields, then any raw tails. */
function pack(fields: Field[], ...tails: Uint8Array[]): Uint8Array {
  const head = fields.reduce((n, [w]) => n + w, 0);
  const out = new Uint8Array(tails.reduce((n, t) => n + t.length, head));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const [width, value] of fields) {
    if (width === 2) v.setUint16(at, value, true);
    else if (width === 4) v.setUint32(at, value, true);
    else v.setBigUint64(at, BigInt(value), true);
    at += width;
  }
  for (const t of tails) {
    out.set(t, at);
    at += t.length;
  }
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * The name an extractor will write: separators are `/`, a drive letter and leading slashes are dropped, empty
 * segments vanish, and a `.` or `..` segment, a control character or an empty result throws. A name already in
 * `used` (compared without case, as Windows and macOS extract) gets ` (2)`, ` (3)` before its extension.
 */
export function entryName(name: string, used: ReadonlySet<string>): string {
  const segments = name
    .replaceAll("\\", "/")
    .replace(/^[A-Za-z]:/, "")
    .split("/")
    .filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => s === "." || s === ".." || CONTROL.test(s))) {
    throw new RangeError("zip64: unsafe entry name");
  }
  const path = segments.join("/");
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > path.lastIndexOf("/") + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  let candidate = path;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  return candidate;
}

/** MS-DOS time and date; a year outside 1980 to 2107 is clamped to it. */
function dosTime(d: Date): [time: number, date: number] {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

export interface EntryRecord {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  modified: Date;
}

/** Local header: sizes are unknown, so the 32-bit fields are saturated and the zip64 extra holds zeros. */
const localHeader = (e: Pick<EntryRecord, "name" | "modified">): Uint8Array => {
  const [time, date] = dosTime(e.modified);
  return pack(
    [
      [4, SIG_LOCAL],
      [2, VERSION],
      [2, FLAGS],
      [2, STORE],
      [2, time],
      [2, date],
      [4, 0],
      [4, U32_MAX],
      [4, U32_MAX],
    ],
    pack([
      [2, e.name.length],
      [2, 20],
    ]),
    e.name,
    pack([
      [2, EXTRA_ZIP64],
      [2, 16],
      [8, 0],
      [8, 0],
    ]),
  );
};

const descriptor = (e: Pick<EntryRecord, "crc" | "size">): Uint8Array =>
  pack([
    [4, SIG_DESCRIPTOR],
    [4, e.crc],
    [8, e.size],
    [8, e.size],
  ]);

/** Central record: a size or offset that fits 32 bits stays there; one that does not moves to the zip64 extra. */
export function centralRecord(e: EntryRecord): Uint8Array {
  const [time, date] = dosTime(e.modified);
  const bigSize = e.size >= U32_MAX;
  const bigOffset = e.offset >= U32_MAX;
  const extra: Field[] = [];
  if (bigSize) extra.push([8, e.size], [8, e.size]);
  if (bigOffset) extra.push([8, e.offset]);
  const extraBytes = extra.length ? pack([[2, EXTRA_ZIP64], [2, extra.length * 8], ...extra]) : new Uint8Array();
  const size32 = bigSize ? U32_MAX : e.size;
  return pack(
    [
      [4, SIG_CENTRAL],
      [2, VERSION],
      [2, VERSION],
      [2, FLAGS],
      [2, STORE],
      [2, time],
      [2, date],
      [4, e.crc],
      [4, size32],
      [4, size32],
      [2, e.name.length],
      [2, extraBytes.length],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, 0],
      [4, bigOffset ? U32_MAX : e.offset],
    ],
    e.name,
    extraBytes,
  );
}

/** The end of the archive: zip64 end record and locator when a count or offset overflows, then the classic record. */
export function endRecords(count: number, directorySize: number, directoryOffset: number): Uint8Array {
  const big = count >= U16_MAX || directorySize >= U32_MAX || directoryOffset >= U32_MAX;
  const zip64 = big
    ? [
        pack([
          [4, SIG_END64],
          [8, 44],
          [2, VERSION],
          [2, VERSION],
          [4, 0],
          [4, 0],
          [8, count],
          [8, count],
          [8, directorySize],
          [8, directoryOffset],
        ]),
        pack([
          [4, SIG_LOCATOR64],
          [4, 0],
          [8, directoryOffset + directorySize],
          [4, 1],
        ]),
      ]
    : [];
  const sat = (v: number, max: number) => (big ? max : v);
  const classic = pack([
    [4, SIG_END],
    [2, 0],
    [2, 0],
    [2, sat(count, U16_MAX)],
    [2, sat(count, U16_MAX)],
    [4, sat(directorySize, U32_MAX)],
    [4, sat(directoryOffset, U32_MAX)],
    [2, 0],
  ]);
  return pack([], ...zip64, classic);
}

export class Zip64Writer {
  /** Consume this while adding entries: an unread archive stalls `add` once the stream's buffer is full. */
  readonly readable: ReadableStream<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #central: Uint8Array[] = [];
  readonly #names = new Set<string>();
  #offset = 0;
  #busy = false;

  constructor() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = readable;
    this.#writer = writable.getWriter();
  }

  async #emit(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    await this.#writer.write(chunk);
    this.#offset += chunk.length;
  }

  /**
   * One entry at a time: await each `add` before the next. The name goes through `entryName` (an unsafe one throws
   * with nothing written); a failing body aborts the whole archive.
   */
  async add(name: string, body: ReadableStream<Uint8Array>, modified = new Date()): Promise<void> {
    if (this.#busy) throw new Error("zip64: add while another entry is open");
    const stored = entryName(name, this.#names);
    const nameBytes = new TextEncoder().encode(stored);
    if (nameBytes.length > U16_MAX) throw new RangeError("zip64: entry name too long");
    this.#busy = true;
    const reader = body.getReader();
    try {
      this.#names.add(stored.toLowerCase());
      const entry: EntryRecord = { name: nameBytes, crc: 0, size: 0, offset: this.#offset, modified };
      await this.#emit(localHeader(entry));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.crc = crc32(value, entry.crc);
        entry.size += value.length;
        await this.#emit(value);
      }
      await this.#emit(descriptor(entry));
      this.#central.push(centralRecord(entry));
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      await this.#writer.abort(error).catch(() => {});
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /** Writes the central directory and end records, then closes `readable`. */
  async finish(): Promise<void> {
    if (this.#busy) throw new Error("zip64: finish while an entry is open");
    const directoryOffset = this.#offset;
    let directorySize = 0;
    for (const record of this.#central) {
      await this.#emit(record);
      directorySize += record.length;
    }
    await this.#emit(endRecords(this.#central.length, directorySize, directoryOffset));
    await this.#writer.close();
  }
}
