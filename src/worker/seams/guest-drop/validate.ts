// What a stored object really is (DROP-02 to DROP-04). Range reads only: the head, the zip end record and
// central directory, or the PDF or image tail. The one inflate is the content-types part, capped at a few hundred KB.
import type { DropError, FileType } from "../../../shared/protocol.ts";
import { type RangeReader, ZIP_LIMITS } from "./index.ts";
import { checkSizes, entryBytes, hasEndRecord, readCentralDirectory, type ZipEntry } from "./zip.ts";

const HEAD_BYTES = 1024;
const PDF_EOF_WINDOW = 1024;
const JPEG_EOI_WINDOW = 1024;
const PNG_END_BYTES = 12; // the IEND chunk: length 0, "IEND", CRC
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MOV_BRAND = "qt  ";
const MP4_BRANDS: ReadonlySet<string> = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]);
/** What may follow the `ftyp` box: a real file goes straight into its movie, data or padding boxes. */
const BOX_AFTER_FTYP: ReadonlySet<string> = new Set(["moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "junk"]);
const MIN_FTYP_BYTES = 16;
const text = new TextDecoder("latin1");
const hasMagic = (b: Uint8Array, magic: number[]) => b.length >= magic.length && magic.every((m, i) => b[i] === m);
const startsWith = (b: Uint8Array, s: string) => s.length <= b.length && text.decode(b.subarray(0, s.length)) === s;

type Verdict = { ok: true; type: FileType } | { ok: false; error: DropError };
const refuse = (error: DropError): Verdict => ({ ok: false, error });

/** The major brand of an ISO base media file (`ftyp` at offset 4), or null. */
const majorBrand = (head: Uint8Array): string | null =>
  head.length >= 12 && text.decode(head.subarray(4, 8)) === "ftyp" ? text.decode(head.subarray(8, 12)) : null;

/** What the first bytes say the file is, or null. HEIC and every other `ftyp` brand are none. */
function detect(head: Uint8Array): FileType | null {
  if (startsWith(head, "PK\x03\x04")) return "pptx";
  if (startsWith(head, "%PDF-")) return "pdf";
  if (hasMagic(head, JPEG_MAGIC)) return "jpg";
  if (hasMagic(head, PNG_MAGIC)) return "png";
  const brand = majorBrand(head);
  if (brand === MOV_BRAND) return "mov";
  return brand !== null && MP4_BRANDS.has(brand) ? "mp4" : null;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const out = new Response(
    new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).body?.getReader();
  if (!out) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await out.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await out.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return joined;
}

/** The text of `[Content_Types].xml`, or null when it cannot be read within its cap. */
async function contentTypes(r: RangeReader, entry: ZipEntry): Promise<string | null> {
  const cap = ZIP_LIMITS.maxContentTypesBytes;
  if (entry.uncompressed > cap || entry.compressed > cap) return null;
  const stored = await entryBytes(r, entry);
  if (!stored) return null;
  if (entry.method === 0) return text.decode(stored);
  if (entry.method !== 8) return null;
  const inflated = await inflateRaw(stored, cap);
  return inflated ? new TextDecoder("utf-8").decode(inflated) : null;
}

async function validateDeck(r: RangeReader, head: Uint8Array): Promise<Verdict> {
  if (text.decode(head).includes("%PDF")) return refuse("bad_structure");
  const dir = await readCentralDirectory(r);
  if (!dir.ok) return refuse(dir.error);
  const sizes = checkSizes(dir.entries);
  if (sizes) return refuse(sizes);
  const names = new Map(dir.entries.map((e) => [e.name, e]));
  if (dir.entries.some((e) => e.method !== 0 && e.method !== 8)) return refuse("bad_structure");
  if (dir.entries.some((e) => ZIP_LIMITS.refusedParts.some((p) => p.test(e.name)))) return refuse("macro_content");
  if (!ZIP_LIMITS.requiredParts.every((p) => names.has(p))) return refuse("bad_structure");
  const types = await contentTypes(r, names.get("[Content_Types].xml") as ZipEntry);
  if (types === null) return refuse("bad_structure");
  if (ZIP_LIMITS.refusedContentTypes.some((p) => p.test(types))) return refuse("macro_content");
  return { ok: true, type: "pptx" };
}

async function validatePdf(r: RangeReader): Promise<Verdict> {
  if (await hasEndRecord(r)) return refuse("bad_structure");
  const tail = await r.read(Math.max(0, r.size - PDF_EOF_WINDOW), Math.min(r.size, PDF_EOF_WINDOW));
  return text.decode(tail).includes("%%EOF") ? { ok: true, type: "pdf" } : refuse("bad_structure");
}

/**
 * An image is drawn by an <img> under a fixed type, so it needs no deeper parse: it must end where its format ends
 * (JPEG end-of-image in the last KB, PNG IEND as the last chunk) and carry no zip end record (DROP-11).
 */
async function validateImage(r: RangeReader, type: FileType): Promise<Verdict> {
  if (await hasEndRecord(r)) return refuse("bad_structure");
  if (type === "png") {
    const end = await r.read(Math.max(0, r.size - PNG_END_BYTES), PNG_END_BYTES);
    return text.decode(end.subarray(4, 8)) === "IEND" ? { ok: true, type } : refuse("bad_structure");
  }
  const tail = await r.read(Math.max(0, r.size - JPEG_EOI_WINDOW), Math.min(r.size, JPEG_EOI_WINDOW));
  return tail.some((b, i) => b === 0xff && tail[i + 1] === 0xd9) ? { ok: true, type } : refuse("bad_structure");
}

/**
 * A video is played by a <video> under a fixed `video/mp4`, so it is not parsed: the `ftyp` box must be well
 * formed and be followed by a movie, data or padding box (not text, HTML or another format), with no `%PDF` in the
 * head, and no zip end record or PDF `%%EOF` in the tail (DROP-02, VID-01).
 */
async function validateVideo(r: RangeReader, head: Uint8Array, type: FileType): Promise<Verdict> {
  if (text.decode(head).includes("%PDF")) return refuse("bad_structure");
  const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  if (size < MIN_FTYP_BYTES || size + 8 > head.length) return refuse("bad_structure");
  if (!BOX_AFTER_FTYP.has(text.decode(head.subarray(size + 4, size + 8)))) return refuse("bad_structure");
  if (await hasEndRecord(r)) return refuse("bad_structure");
  const tail = await r.read(Math.max(0, r.size - PDF_EOF_WINDOW), Math.min(r.size, PDF_EOF_WINDOW));
  return text.decode(tail).includes("%%EOF") ? refuse("bad_structure") : { ok: true, type };
}

/** The detected type must equal the declared one (the extension); anything else is `bad_type`. */
export const validate = async (r: RangeReader, declared: FileType): Promise<Verdict> => {
  const head = await r.read(0, Math.min(r.size, HEAD_BYTES));
  const detected = detect(head);
  if (detected === null || detected !== declared) return refuse("bad_type");
  if (detected === "pptx") return validateDeck(r, head);
  if (detected === "pdf") return validatePdf(r);
  if (detected === "mp4" || detected === "mov") return validateVideo(r, head, detected);
  return validateImage(r, detected);
};
