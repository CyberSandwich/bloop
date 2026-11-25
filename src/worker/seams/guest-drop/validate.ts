// What a stored object really is (DROP-02 to DROP-04). Range reads only: the head, the zip end record and
// central directory, or the PDF or image tail. The one inflate is the content-types part, capped at a few hundred KB.
import type { DropError, FileType } from "../../../shared/protocol.ts";
import { inflate, latin1, majorBrand, startsWith } from "./bytes.ts";
import { isRefusedPart } from "./formats.ts";
import { type RangeReader, ZIP_LIMITS } from "./index.ts";
import { checkSizes, entryBytes, hasEndRecord, readCentralDirectory, type ZipEntry } from "./zip.ts";

const HEAD_BYTES = 1024;
/** Where a PDF's `%%EOF` and a JPEG's end-of-image must sit. */
const TAIL_BYTES = 1024;
const PNG_END_BYTES = 12; // the IEND chunk: length 0, "IEND", CRC
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MOV_BRAND = "qt  ";
const MP4_BRANDS: ReadonlySet<string> = new Set([
  ...["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp71", "avc1", "dash"],
  ...["M4V ", "M4VP", "3gp4", "3gp5", "XAVC"],
]);
/** What may follow the `ftyp` box: a real file goes straight into its movie, data, fragment, index, metadata or padding boxes. */
const BOX_AFTER_FTYP: ReadonlySet<string> = new Set([
  ...["moov", "mdat", "moof", "meta", "pdin", "sidx"],
  ...["free", "skip", "wide", "pnot", "uuid", "junk"],
]);
const MIN_FTYP_BYTES = 16;
const hasMagic = (b: Uint8Array, magic: number[]) => b.length >= magic.length && magic.every((m, i) => b[i] === m);

type Verdict = { ok: true; type: FileType } | { ok: false; error: DropError };
const refuse = (error: DropError): Verdict => ({ ok: false, error });

const readTail = (r: RangeReader): Promise<Uint8Array> =>
  r.read(Math.max(0, r.size - TAIL_BYTES), Math.min(r.size, TAIL_BYTES));

/**
 * A PDF or a ZIP riding on a media file: `%PDF` in the head (a PDF reader looks there), a zip end record, or `%%EOF`
 * in the tail (DROP-11, VID-01).
 */
async function carriesAnother(r: RangeReader, head: Uint8Array, tail: Uint8Array): Promise<boolean> {
  return latin1.decode(head).includes("%PDF") || latin1.decode(tail).includes("%%EOF") || (await hasEndRecord(r));
}

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

/** The text of `[Content_Types].xml`, or null when it cannot be read within its cap. */
async function contentTypes(r: RangeReader, entry: ZipEntry): Promise<string | null> {
  const cap = ZIP_LIMITS.maxContentTypesBytes;
  if (entry.uncompressed > cap || entry.compressed > cap) return null;
  const stored = await entryBytes(r, entry);
  if (!stored) return null;
  if (entry.method === 0) return latin1.decode(stored);
  if (entry.method !== 8) return null;
  const inflated = await inflate(stored, cap, "deflate-raw");
  return inflated ? new TextDecoder("utf-8").decode(inflated) : null;
}

async function validateDeck(r: RangeReader, head: Uint8Array): Promise<Verdict> {
  if (latin1.decode(head).includes("%PDF")) return refuse("bad_structure");
  const dir = await readCentralDirectory(r);
  if (!dir.ok) return refuse(dir.error);
  const sizes = checkSizes(dir.entries);
  if (sizes) return refuse(sizes);
  const names = new Map(dir.entries.map((e) => [e.name, e]));
  if (dir.entries.some((e) => e.method !== 0 && e.method !== 8)) return refuse("bad_structure");
  if (dir.entries.some((e) => isRefusedPart(e.name))) return refuse("macro_content");
  if (!ZIP_LIMITS.requiredParts.every((p) => names.has(p))) return refuse("bad_structure");
  const types = await contentTypes(r, names.get("[Content_Types].xml") as ZipEntry);
  if (types === null) return refuse("bad_structure");
  if (ZIP_LIMITS.refusedContentTypes.some((p) => p.test(types))) return refuse("macro_content");
  return { ok: true, type: "pptx" };
}

async function validatePdf(r: RangeReader): Promise<Verdict> {
  if (await hasEndRecord(r)) return refuse("bad_structure");
  const tail = await readTail(r);
  return latin1.decode(tail).includes("%%EOF") ? { ok: true, type: "pdf" } : refuse("bad_structure");
}

/**
 * An image is drawn by an <img> under a fixed type, so it needs no deeper parse: it must end where its format ends
 * (JPEG end-of-image in the last KB, PNG IEND as the last chunk) and carry no PDF or ZIP (DROP-11).
 */
async function validateImage(r: RangeReader, head: Uint8Array, type: FileType): Promise<Verdict> {
  const tail = await readTail(r);
  if (await carriesAnother(r, head, tail)) return refuse("bad_structure");
  if (type === "png") {
    const end = tail.subarray(-PNG_END_BYTES);
    return end.length === PNG_END_BYTES && latin1.decode(end.subarray(4, 8)) === "IEND"
      ? { ok: true, type }
      : refuse("bad_structure");
  }
  return tail.some((b, i) => b === 0xff && tail[i + 1] === 0xd9) ? { ok: true, type } : refuse("bad_structure");
}

/**
 * A video is played by a <video> under a fixed `video/mp4`, so it is not parsed: the `ftyp` box must be well
 * formed and be followed by a movie, data or padding box (not text, HTML or another format), with no `%PDF` in the
 * head, and no zip end record or PDF `%%EOF` in the tail (DROP-02, VID-01).
 */
async function validateVideo(r: RangeReader, head: Uint8Array, type: FileType): Promise<Verdict> {
  const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  if (size < MIN_FTYP_BYTES || size + 8 > head.length) return refuse("bad_structure");
  if (!BOX_AFTER_FTYP.has(latin1.decode(head.subarray(size + 4, size + 8)))) return refuse("bad_structure");
  return (await carriesAnother(r, head, await readTail(r))) ? refuse("bad_structure") : { ok: true, type };
}

/** The detected type must equal the declared one (the extension); anything else is `bad_type`. */
export const validate = async (r: RangeReader, declared: FileType): Promise<Verdict> => {
  const head = await r.read(0, Math.min(r.size, HEAD_BYTES));
  const detected = detect(head);
  if (detected === null || detected !== declared) return refuse("bad_type");
  if (detected === "pptx") return validateDeck(r, head);
  if (detected === "pdf") return validatePdf(r);
  if (detected === "mp4" || detected === "mov") return validateVideo(r, head, detected);
  return validateImage(r, head, detected);
};
