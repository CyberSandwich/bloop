// PDF active-content scan (DROP-13): a name-token scan, not a parser. The bytes are read as Latin-1, every `/Name`
// token is decoded (`#xx` escapes, so `/J#61vaScript` is `/JavaScript`) and compared with the refused set. Object
// streams (`/ObjStm`), where a PDF 1.5 file hides its dictionaries, are inflated and scanned the same way.
//
// Limits: the scan covers names, not stream payloads (an XFA form's XML, an embedded file's bytes, a content stream).
// A name inside a string or comment also matches (fail closed). An object stream is read only when its dictionary is
// exactly the plain form (`/Type /ObjStm`, `/N`, `/First`, `/Length`, `/Extends` and one `/Filter /FlateDecode`) and
// sits within `DICT_LOOKBACK` bytes of its `stream` keyword; anything else, and any `/ObjStm` token that no scanned
// stream accounts for (a `stream\r` keyword, a dictionary too far back), is refused as `unscannable`, as is any
// `/Encrypt` (its streams are ciphertext). The scan stops at the first unscannable stream. Names built at run time by
// a script are the script's own business: `/JS` and `/JavaScript` already refuse the script.
import { inflate, latin1 } from "./bytes.ts";
import { type Check, fail, OK } from "./formats.ts";

/**
 * The most this in-memory scan reads (the bytes and their Latin-1 text are both held). A larger file gets the
 * verdict `needs_stream_scan` (not ok, error `too_large`): a chunked scan can answer it later without an API change.
 */
export const MAX_PDF_BYTES = 32 * 1024 * 1024;

const REFUSED: ReadonlySet<string> = new Set([
  ...["JS", "JavaScript", "Launch", "EmbeddedFile", "EmbeddedFiles", "OpenAction", "Encrypt"],
  ...["XFA", "AA", "GoToR", "GoToE", "SubmitForm", "ImportData", "RichMedia"],
]);
/** The keys of a plain object stream dictionary, and the one filter it may name. */
const OBJSTM_KEYS: ReadonlySet<string> = new Set([
  ...["Type", "ObjStm", "N", "First", "Length", "Filter", "FlateDecode", "Extends"],
]);
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 32 * 1024 * 1024;
const DICT_LOOKBACK = 4096;

// PDF white space includes NUL; delimiters end a name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is PDF white space
const NAME = /\/[^\x00\t\n\f\r /<>[\](){}%]+/g;
/** A dictionary opening (`obj<<`) or a stream keyword with its EOL, found in one pass. */
const MARKS = /(?<!end)obj\s*<<|(?<!end)stream\r?\n/g;

const decodeName = (token: string): string =>
  token.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

/** The decoded names in `text`, one at a time: a hostile file has millions. */
function* names(text: string): Generator<string> {
  for (const m of text.matchAll(NAME)) yield decodeName(m[0]);
}

/** The end of a stream's data: the EOL before `endstream` is not part of it, and inflate rejects trailing bytes. */
function withoutEol(pdf: Uint8Array, from: number, to: number): number {
  if (to - from >= 2 && pdf[to - 2] === 0x0d && pdf[to - 1] === 0x0a) return to - 2;
  return to > from && (pdf[to - 1] === 0x0a || pdf[to - 1] === 0x0d) ? to - 1 : to;
}

/** True when `dict` is the plain object stream dictionary: allowed keys only, one Flate filter, no array or nesting. */
function plainObjStm(dict: string): boolean {
  const open = dict.indexOf("<<");
  if (open === -1 || dict.indexOf("<<", open + 2) !== -1 || dict.includes("[") || dict.includes("(")) return false;
  const seen = [...names(dict)];
  return seen.every((n) => OBJSTM_KEYS.has(n)) && seen.filter((n) => n === "FlateDecode").length === 1;
}

const refusal = (found: Iterable<string>): Check & { found: string[] } => ({
  ...fail("macro_content", "pdf active content"),
  found: [...found],
});

/** Every refused name in the file or its object streams, deduplicated; `unscannable` when a stream could not be read. */
export async function scanPdf(pdf: Uint8Array): Promise<Check & { found?: string[] }> {
  if (pdf.length > MAX_PDF_BYTES) return fail("too_large", "needs_stream_scan");
  const text = latin1.decode(pdf);
  const found = new Set<string>();
  let objStmTokens = 0;
  for (const n of names(text)) {
    if (REFUSED.has(n)) found.add(n);
    if (n === "ObjStm") objStmTokens++;
  }

  let scanned = 0;
  let budget = MAX_TOTAL_INFLATED;
  let dictAt = -1;
  const marks = new RegExp(MARKS);
  for (let m = marks.exec(text); m !== null; m = marks.exec(text)) {
    if (!m[0].startsWith("stream")) {
      dictAt = m.index;
      continue;
    }
    const dictStart = dictAt;
    dictAt = -1;
    if (dictStart === -1 || m.index - dictStart > DICT_LOOKBACK) continue;
    const dict = text.slice(dictStart, m.index);
    if (![...names(dict)].includes("ObjStm")) continue;
    const from = m.index + m[0].length;
    const end = text.indexOf("endstream", from);
    const inflated =
      end === -1 || !plainObjStm(dict)
        ? null
        : await inflate(pdf.subarray(from, withoutEol(pdf, from, end)), Math.min(MAX_STREAM_BYTES, budget), "deflate");
    if (!inflated) return refusal(found.add("unscannable"));
    budget -= inflated.length;
    scanned++;
    for (const n of names(latin1.decode(inflated))) if (REFUSED.has(n)) found.add(n);
    marks.lastIndex = end;
  }
  if (scanned !== objStmTokens) found.add("unscannable");
  return found.size === 0 ? OK : refusal(found);
}
