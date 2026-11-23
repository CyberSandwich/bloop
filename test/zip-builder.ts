// Crafts zip files for the guest-drop tests, including ones whose central directory lies.
import { deflateRawSync } from "node:zlib";

export interface BuiltEntry {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate. */
  method?: 0 | 8;
  /** Override what the central directory declares. */
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

const enc = new TextEncoder();
const bytes = (d: Uint8Array | string | undefined) => (typeof d === "string" ? enc.encode(d) : (d ?? new Uint8Array()));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function le(...fields: [number, 2 | 4][]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [, w]) => n + w, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const [value, width] of fields) {
    if (width === 2) v.setUint16(at, value, true);
    else v.setUint32(at, value, true);
    at += width;
  }
  return out;
}

export function buildZip(entries: BuiltEntry[], comment = ""): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = bytes(e.data);
    const method = e.method ?? 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(e.name);
    const csize = e.declaredCompressed ?? stored.length;
    const usize = e.declaredUncompressed ?? raw.length;
    const local = concat([
      le([0x04034b50, 4], [20, 2], [0, 2], [method, 2], [0, 2], [0, 2], [0, 4], [csize, 4], [usize, 4]),
      le([name.length, 2], [0, 2]),
      name,
      stored,
    ]);
    central.push(
      concat([
        le(
          [0x02014b50, 4],
          [20, 2],
          [20, 2],
          [0, 2],
          [method, 2],
          [0, 2],
          [0, 2],
          [0, 4],
          [csize, 4],
          [usize, 4],
          [name.length, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 4],
          [offset, 4],
        ),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(central);
  const note = enc.encode(comment);
  const end = concat([
    le(
      [0x06054b50, 4],
      [0, 2],
      [0, 2],
      [entries.length, 2],
      [entries.length, 2],
      [cd.length, 4],
      [offset, 4],
      [note.length, 2],
    ),
    note,
  ]);
  return concat([...locals, cd, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';

/** A minimal structurally valid deck. */
export const validDeck = (extra: BuiltEntry[] = [], contentTypes = CONTENT_TYPES): Uint8Array =>
  buildZip([
    { name: "[Content_Types].xml", data: contentTypes, method: 8 },
    { name: "ppt/presentation.xml", data: "<p:presentation/>", method: 8 },
    ...extra,
  ]);

export const validPdf = (): Uint8Array => enc.encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

export { concat };

/** A RangeReader over a byte array, for the pure validators. */
export const reader = (data: Uint8Array) => ({
  size: data.length,
  read: async (offset: number, length: number) => data.slice(offset, offset + length),
});
