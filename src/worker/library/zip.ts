// The export archive as a pure function of its entries (docs/library.md, export). Every CRC and size is known before the
// first byte, so STORE entries carry them in their local headers and need no data descriptor; the layout is a table of
// segments, which gives the exact length and lets a Range start anywhere. Zip64 covers offsets and the end record only:
// an entry's own size always fits 32 bits (the upload cap is 500 MB).
import { crc32 } from "../crc32.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** Bit 11: the name is UTF-8. Bit 3 stays clear. */
const FLAGS = 0x0800;
const VERSION_PLAIN = 20;
const VERSION_ZIP64 = 45;
const EXTRA_ZIP64 = 0x0001;
const STORE = 0;

/** Where a segment's bytes come from: memory, or an object of the user's library. */
export type Source = { bytes: Uint8Array } | { key: string };

export type EntryInput =
  | { name: string; modified: Date; bytes: Uint8Array }
  | { name: string; modified: Date; key: string; size: number; crc: number };

export interface Segment {
  start: number;
  length: number;
  source: Source;
}

export interface Archive {
  length: number;
  segments: Segment[];
  /** Each entry's name, size and CRC in archive order: what the ETag and `data.json` are made from. */
  entries: { name: string; size: number; crc: number }[];
}

/** A run of one source: `offset` bytes into it, `length` long. */
export interface Piece {
  source: Source;
  offset: number;
  length: number;
}

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

/** MS-DOS time and date in UTC, so the archive does not depend on the server's zone; a year outside 1980 to 2107 is clamped. */
function dosTime(d: Date): [time: number, date: number] {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return [
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  ];
}

interface Placed {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  modified: Date;
}

const localHeader = (e: Placed): Uint8Array => {
  const [time, date] = dosTime(e.modified);
  return pack(
    [
      [4, SIG_LOCAL],
      [2, VERSION_PLAIN],
      [2, FLAGS],
      [2, STORE],
      [2, time],
      [2, date],
      [4, e.crc],
      [4, e.size],
      [4, e.size],
      [2, e.name.length],
      [2, 0],
    ],
    e.name,
  );
};

/** A 32-bit offset that overflows moves to a Zip64 extra; nothing else in a record can. */
const centralRecord = (e: Placed): Uint8Array => {
  const [time, date] = dosTime(e.modified);
  const big = e.offset >= U32_MAX;
  const extra = big
    ? pack([
        [2, EXTRA_ZIP64],
        [2, 8],
        [8, e.offset],
      ])
    : new Uint8Array();
  return pack(
    [
      [4, SIG_CENTRAL],
      [2, VERSION_ZIP64],
      [2, big ? VERSION_ZIP64 : VERSION_PLAIN],
      [2, FLAGS],
      [2, STORE],
      [2, time],
      [2, date],
      [4, e.crc],
      [4, e.size],
      [4, e.size],
      [2, e.name.length],
      [2, extra.length],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, 0],
      [4, big ? U32_MAX : e.offset],
    ],
    e.name,
    extra,
  );
};

/** The Zip64 end record and locator when a count or offset overflows, then the classic record, always. */
function endRecords(count: number, directorySize: number, directoryOffset: number): Uint8Array {
  const big = count >= U16_MAX || directorySize >= U32_MAX || directoryOffset >= U32_MAX;
  const zip64 = big
    ? [
        pack([
          [4, SIG_END64],
          [8, 44],
          [2, VERSION_ZIP64],
          [2, VERSION_ZIP64],
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

/**
 * Lays out the archive. An in-memory entry's CRC is computed here and nowhere else: an object's CRC comes from its row,
 * so no stored byte is ever hashed. An entry whose size does not fit 32 bits, or whose name does not fit 16, throws.
 */
export function layoutArchive(inputs: readonly EntryInput[]): Archive {
  const encoder = new TextEncoder();
  const segments: Segment[] = [];
  const entries: Archive["entries"] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (source: Source, length: number) => {
    if (length === 0) return;
    segments.push({ start: offset, length, source });
    offset += length;
  };
  for (const input of inputs) {
    const name = encoder.encode(input.name);
    const size = "bytes" in input ? input.bytes.length : input.size;
    const crc = "bytes" in input ? crc32(input.bytes) : input.crc;
    if (name.length === 0 || name.length > U16_MAX) throw new RangeError("zip: entry name length");
    if (!Number.isSafeInteger(size) || size < 0 || size >= U32_MAX) throw new RangeError("zip: entry size");
    const placed: Placed = { name, crc, size, offset, modified: input.modified };
    push({ bytes: localHeader(placed) }, 30 + name.length);
    push("bytes" in input ? { bytes: input.bytes } : { key: input.key }, size);
    central.push(centralRecord(placed));
    entries.push({ name: input.name, size, crc });
  }
  const directory = pack([], ...central);
  push({ bytes: directory }, directory.length);
  const end = endRecords(central.length, directory.length, offset - directory.length);
  push({ bytes: end }, end.length);
  return { length: offset, segments, entries };
}

/** The runs that make up bytes `start` to `end` inclusive, clamped to the archive. */
export function piecesOf(archive: Archive, start: number, end: number): Piece[] {
  const last = Math.min(end, archive.length - 1);
  const out: Piece[] = [];
  for (const s of archive.segments) {
    const from = Math.max(start, s.start);
    const to = Math.min(last, s.start + s.length - 1);
    if (from <= to) out.push({ source: s.source, offset: from - s.start, length: to - from + 1 });
  }
  return out;
}
