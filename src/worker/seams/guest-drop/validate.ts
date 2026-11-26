// What a stored object really is (DROP-02 to DROP-04, DROP-11 to DROP-16), for every format in `FORMATS`. Range reads
// only: the head, the zip end record and central directory, the PDF or image tail, a JPEG's or GIF's headers in small
// blocks. The one inflate in a package is its content types and relationships parts, capped at a few hundred KB; a
// PDF is read whole when small, else in windows. Every validator reads through the one plan `validate` makes, so a
// small object is one read and a large one at most `READ_PLAN.maxReads`.
import { inflate, latin1 } from "./bytes.ts";
import { scanCfb } from "./cfb.ts";
import {
  type Check,
  checkOoxml,
  checkText,
  decodeXml,
  detect,
  FORMATS,
  type FormatType,
  isRefusedPart,
  isRelsPart,
  MAX_TEXT_BYTES,
  type Refusal,
} from "./formats.ts";
import { checkImageSize } from "./image.ts";
import { type RangeReader, readExact, ShortRead, ZIP_LIMITS } from "./index.ts";
import { PDF_WINDOW_BYTES, scanPdfChunks } from "./pdf-scan.ts";
import { planReads, READ_PLAN, ReadBudgetExceeded, readParts } from "./read-plan.ts";
import { checkSizes, hasEndRecord, readCentralDirectory, type ZipEntry } from "./zip.ts";

/**
 * The largest object validated, above the library's 500 MiB file cap; past it `too_large`. A PDF this size fits the
 * read plan: its head, two tails and 64 windows.
 */
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const HEAD_BYTES = 1024;
/** Where a PDF's `%%EOF` must sit, and the window searched for `%%EOF` in an image or video. */
const TAIL_BYTES = 1024;
const PNG_END_BYTES = 12; // the IEND chunk: length 0, "IEND", CRC
const GIF_TRAILER = 0x3b;
const MIN_FTYP_BYTES = 16;
/** What may follow the `ftyp` box: a real file goes straight into its movie, data, fragment, index, metadata or padding boxes. */
const BOX_AFTER_FTYP: ReadonlySet<string> = new Set([
  ...["moov", "mdat", "moof", "meta", "pdin", "sidx"],
  ...["free", "skip", "wide", "pnot", "uuid", "junk"],
]);
/** A still or sequence in HEIF opens with its `meta` box (or a `moov` for a sequence). */
const BOX_AFTER_HEIC_FTYP: ReadonlySet<string> = new Set(["meta", "moov"]);

export type Verdict<T extends FormatType = FormatType> = { ok: true; type: T } | { ok: false; error: Refusal };
const refuse = (error: Refusal): { ok: false; error: Refusal } => ({ ok: false, error });

const readTail = (r: RangeReader): Promise<Uint8Array> =>
  readExact(r, Math.max(0, r.size - TAIL_BYTES), Math.min(r.size, TAIL_BYTES));

/**
 * A PDF or a ZIP riding on a media file: `%PDF` in the head (a PDF reader looks there), a zip end record, or `%%EOF`
 * in the tail (DROP-11, VID-01).
 */
async function carriesAnother(r: RangeReader, head: Uint8Array, tail: Uint8Array): Promise<boolean> {
  return latin1.decode(head).includes("%PDF") || latin1.decode(tail).includes("%%EOF") || (await hasEndRecord(r));
}

/** The relationships parts of a deck: how many, and how many inflated bytes in all. A real deck has one per slide. */
const MAX_RELS_PARTS = 1024;
const MAX_RELS_BYTES = 4 * 1024 * 1024;
/** The most stored bytes one XML part, and all of them together, may ask the read plan for. */
const PART_LIMITS = { maxEach: ZIP_LIMITS.maxContentTypesBytes, maxTotal: 8 * 1024 * 1024 } as const;
const CONTENT_TYPES_PART = "[Content_Types].xml";

/** The bytes of one stored part, inflated to at most `cap` when it is deflated; null when they cannot be read so. */
async function unpack(stored: Uint8Array | null, method: number, cap: number): Promise<Uint8Array | null> {
  if (stored === null) return null;
  if (method === 0) return stored.length <= cap ? stored : null;
  return method === 8 ? inflate(stored, cap, "deflate-raw") : null;
}

/** The text of the content types and of every relationships part, read in one plan; null when any cannot be read. */
async function packageXml(
  r: RangeReader,
  entries: readonly ZipEntry[],
  contentTypes: ZipEntry,
): Promise<{ types: string; rels: Map<string, string> } | null> {
  const relsEntries = entries.filter((e) => isRelsPart(e.name));
  if (relsEntries.length > MAX_RELS_PARTS) return null;
  const wanted = [contentTypes, ...relsEntries];
  const stored = await readParts(r, wanted, PART_LIMITS);
  if (stored === null) return null;
  const typesBytes = await unpack(stored[0] ?? null, contentTypes.method, ZIP_LIMITS.maxContentTypesBytes);
  const types = typesBytes === null ? null : decodeXml(typesBytes);
  const rels = new Map<string, string>();
  let budget = MAX_RELS_BYTES;
  for (const [i, entry] of relsEntries.entries()) {
    const bytes = await unpack(stored[i + 1] ?? null, entry.method, Math.min(ZIP_LIMITS.maxContentTypesBytes, budget));
    const text = bytes === null ? null : decodeXml(bytes);
    if (bytes === null || text === null) return null;
    budget -= bytes.length;
    rels.set(entry.name, text);
  }
  return types === null ? null : { types, rels };
}

async function validatePackage<T extends FormatType>(
  r: RangeReader,
  head: Uint8Array,
  type: T,
  part: string,
): Promise<Verdict<T>> {
  if (latin1.decode(head).includes("%PDF")) return refuse("bad_structure");
  const dir = await readCentralDirectory(r);
  if (!dir.ok) return refuse(dir.error);
  const sizes = checkSizes(dir.entries);
  if (sizes) return refuse(sizes);
  const names = new Map(dir.entries.map((e) => [e.name, e]));
  if (dir.entries.some((e) => e.method !== 0 && e.method !== 8)) return refuse("bad_structure");
  if (dir.entries.some((e) => isRefusedPart(e.name))) return refuse("macro_content");
  if (!names.has(CONTENT_TYPES_PART) || !names.has(part)) return refuse("bad_structure");
  const xml = await packageXml(r, dir.entries, names.get(CONTENT_TYPES_PART) as ZipEntry);
  if (xml === null) return refuse("bad_structure");
  const verdict = checkOoxml(
    dir.entries.map((e) => e.name),
    xml.types,
    xml.rels,
  );
  return verdict.ok ? { ok: true, type } : refuse(verdict.error);
}

/** A PDF's active content, its encryption and its structure: the first refusal that applies. */
async function validatePdf(r: RangeReader): Promise<Verdict<"pdf">> {
  if (await hasEndRecord(r)) return refuse("bad_structure");
  if (!latin1.decode(await readTail(r)).includes("%%EOF")) return refuse("bad_structure");
  const scan =
    r.size <= READ_PLAN.smallObjectBytes
      ? await oneWholeScan(() => scanReads(r, r.size))
      : await scanReads(r, PDF_WINDOW_BYTES);
  if (scan.ok) return { ok: true, type: "pdf" };
  const found = new Set("found" in scan ? scan.found : []);
  if (found.has("Encrypt")) return refuse("encrypted");
  return refuse(found.size === 1 && found.has("unscannable") ? "bad_structure" : scan.error);
}

/** The scans waiting for or running the whole-file scan, in order; each one starts when the one before it settles. */
let wholeScans: Promise<unknown> = Promise.resolve();

/**
 * Runs `scan` once no other whole-file scan runs in this isolate. One holds the file, its Latin-1 text and its inflate
 * buffers, tens of MB at the whole-read size, so two together could pass the 128 MB isolate; a windowed scan holds
 * two windows and runs at once.
 */
function oneWholeScan<T>(scan: () => Promise<T>): Promise<T> {
  const run = wholeScans.then(scan);
  wholeScans = run.catch(() => undefined);
  return run;
}

/** The PDF scan over `r` read in order, `window` bytes at a time; each read is one metered class B read. */
function scanReads(r: RangeReader, window: number): Promise<Check & { found?: string[] }> {
  let at = 0;
  return scanPdfChunks(async () => {
    if (at >= r.size) return null;
    const chunk = await readExact(r, at, Math.min(window, r.size - at));
    at += chunk.length;
    return chunk;
  });
}

/**
 * An image is drawn by an <img> under a fixed type, so it needs no deeper parse: its header gives a size within the
 * pixel cap (DROP-16), it ends where its format ends where that is checkable (PNG IEND, GIF trailer, WebP's RIFF
 * length), and it carries no PDF or ZIP (DROP-11). A JPEG may carry bytes after its end marker (a Motion Photo's
 * clip, a maker trailer): a browser ignores them, and the fixed type and `nosniff` keep them inert.
 */
async function validateImage<T extends "jpg" | "png" | "gif" | "webp">(
  r: RangeReader,
  head: Uint8Array,
  type: T,
): Promise<Verdict<T>> {
  const tail = await readTail(r);
  if (await carriesAnother(r, head, tail)) return refuse("bad_structure");
  const sized = await checkImageSize(type, r, head);
  if (!sized.ok) return refuse(sized.error);
  if (type === "png") {
    const end = tail.subarray(-PNG_END_BYTES);
    return end.length === PNG_END_BYTES && latin1.decode(end.subarray(4, 8)) === "IEND"
      ? { ok: true, type }
      : refuse("bad_structure");
  }
  if (type === "gif" && tail.at(-1) !== GIF_TRAILER) return refuse("bad_structure");
  if (
    type === "webp" &&
    new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true) + 8 !== r.size
  ) {
    return refuse("bad_structure");
  }
  return { ok: true, type };
}

/**
 * A video or HEIC still is shown under a fixed type, so it is not parsed: the `ftyp` box must be well formed and be
 * followed by an expected box (not text, HTML or another format), with no `%PDF` in the head, and no zip end record or
 * PDF `%%EOF` in the tail (DROP-02, VID-01).
 */
async function validateIsoMedia<T extends "mp4" | "mov" | "heic">(
  r: RangeReader,
  head: Uint8Array,
  type: T,
): Promise<Verdict<T>> {
  const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  if (size < MIN_FTYP_BYTES || size + 8 > head.length) return refuse("bad_structure");
  const next = latin1.decode(head.subarray(size + 4, size + 8));
  if (!(type === "heic" ? BOX_AFTER_HEIC_FTYP : BOX_AFTER_FTYP).has(next)) return refuse("bad_structure");
  return (await carriesAnother(r, head, await readTail(r))) ? refuse("bad_structure") : { ok: true, type };
}

/** A text file that starts as an HTML page, a script, SVG or XML, after any byte order mark and white space. */
const HTML_START = /^(?:\xef\xbb\xbf)?[\t\n\f\r ]*<(?:!doctype[\t\n\f\r ]+html|html|script|svg|\?xml)\b/i;

/**
 * Text that a reader would take for another format (DROP-02): a binary format's magic, `%PDF` in the head (a PDF
 * reader looks there), a zip local header or end record anywhere, or an HTML, SVG or XML start.
 */
function carriesFormat(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, HEAD_BYTES);
  const headText = latin1.decode(head);
  const all = latin1.decode(bytes);
  return (
    detect(head) !== null ||
    headText.includes("%PDF") ||
    HTML_START.test(headText) ||
    all.includes("PK\x03\x04") ||
    all.includes("PK\x05\x06")
  );
}

async function validateText<T extends FormatType>(r: RangeReader, type: T): Promise<Verdict<T>> {
  if (r.size > MAX_TEXT_BYTES) return refuse("too_large");
  const bytes = await readExact(r, 0, r.size);
  const checked = checkText(bytes);
  if (!checked.ok) return refuse(checked.error);
  return carriesFormat(bytes) ? refuse("bad_structure") : { ok: true, type };
}

/**
 * The detected type must equal the declared one (the extension); anything else is `bad_type`. A short read or a spent
 * read budget is `bad_structure`, never a throw, so the caller deletes the object.
 */
export async function validate<T extends FormatType>(r: RangeReader, declared: T): Promise<Verdict<T>> {
  if (r.size > MAX_OBJECT_BYTES) return refuse("too_large");
  try {
    return await validatePlanned(planReads(r), declared);
  } catch (error) {
    const reason =
      error instanceof ReadBudgetExceeded ? "read_budget" : error instanceof ShortRead ? "short_read" : null;
    if (reason === null) throw error;
    console.warn(JSON.stringify({ evt: "drop.refused", reason, bytes: r.size }));
    return refuse("bad_structure");
  }
}

async function validatePlanned<T extends FormatType>(r: RangeReader, declared: T): Promise<Verdict<T>> {
  const format = FORMATS[declared];
  if (format.family === null) return validateText(r, declared);
  const head = await readExact(r, 0, Math.min(r.size, HEAD_BYTES));
  if (detect(head) !== format.family) return refuse("bad_type");
  switch (format.family) {
    case "zip":
      return validatePackage(r, head, declared, format.part as string);
    case "cfb": {
      const scanned = await scanCfb(r, format.streams as readonly string[]);
      return scanned.ok ? { ok: true, type: declared } : refuse(scanned.error);
    }
    case "pdf":
      return validatePdf(r) as Promise<Verdict<T>>;
    case "mp4":
    case "mov":
    case "heic":
      return validateIsoMedia(r, head, format.family) as Promise<Verdict<T>>;
    case "webm":
      return (await carriesAnother(r, head, await readTail(r)))
        ? refuse("bad_structure")
        : { ok: true, type: declared };
    default:
      return validateImage(r, head, format.family) as Promise<Verdict<T>>;
  }
}
