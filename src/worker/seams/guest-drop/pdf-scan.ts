// PDF active-content scan (DROP-13): a name-token scan, not a parser. The bytes are read as Latin-1, every `/Name`
// token is decoded (`#xx` escapes, so `/J#61vaScript` is `/JavaScript`) and compared with the refused set. Object
// streams (`/ObjStm`), where a PDF 1.5 file hides its dictionaries, are inflated and scanned the same way.
//
// One scanner reads a PDF as a sequence of chunks of any size, so a file of any length is scanned in bounded memory:
// the buffer holds the unscanned tail (a name or a dictionary may straddle two chunks) and, only while an object
// stream's data is incomplete, up to `MAX_STREAM_BYTES` more.
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

/** The next chunk of the file in order, or null at its end. */
export type ChunkSource = () => Promise<Uint8Array | null>;

/** The chunk size a caller reading a stored object should ask for. */
export const PDF_WINDOW_BYTES = 8 * 1024 * 1024;

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
/**
 * Bytes kept unscanned at the end of the buffer: a token longer than this cannot decode to a refused name (the
 * longest is 13 characters, 39 bytes with every character escaped), and a mark's dictionary lies within `DICT_LOOKBACK`.
 */
const HOLD_BACK = 2 * DICT_LOOKBACK;
/** A real file has a handful of object streams; each one costs an inflate. */
export const MAX_OBJECT_STREAMS = 4096;

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

const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * Every refused name in the file or its object streams, deduplicated; `unscannable` when a stream could not be read.
 * Offsets below are absolute (from the file's start); `base` is where the buffer begins.
 */
export async function scanPdfChunks(next: ChunkSource): Promise<Check & { found?: string[] }> {
  const found = new Set<string>();
  let objStmTokens = 0;
  let scanned = 0;
  let budget = MAX_TOTAL_INFLATED;
  let dictAt = -1;
  let base = 0;
  /** Names and marks before this are done (a stream's data can put the marks' cursor further on). */
  let namesDone = 0;
  let marksDone = 0;
  let data: Uint8Array = new Uint8Array();
  let last = false;
  const pull = async (): Promise<void> => {
    const chunk = last ? null : await next();
    if (chunk === null) last = true;
    else data = join(data, chunk);
  };

  while (!last) {
    await pull();
    let text = latin1.decode(data);
    const limit = () => (last ? text.length : Math.max(0, text.length - HOLD_BACK));
    const marks = new RegExp(MARKS);
    for (let m = marks.exec(text); m !== null && m.index < limit(); m = marks.exec(text)) {
      const at = base + m.index;
      if (at < marksDone) continue;
      if (!m[0].startsWith("stream")) {
        dictAt = at;
        continue;
      }
      const dictStart = dictAt;
      dictAt = -1;
      if (dictStart === -1 || at - dictStart > DICT_LOOKBACK) continue;
      const dict = text.slice(dictStart - base, m.index);
      if (![...names(dict)].includes("ObjStm")) continue;
      const from = m.index + m[0].length;
      let end = text.indexOf("endstream", from);
      // The stream's data may run past what has arrived: read on until its end or the most one stream may hold.
      while (end === -1 && !last && data.length - from <= MAX_STREAM_BYTES) {
        await pull();
        text = latin1.decode(data);
        end = text.indexOf("endstream", from);
      }
      const inflated =
        scanned >= MAX_OBJECT_STREAMS || end === -1 || !plainObjStm(dict)
          ? null
          : await inflate(
              data.subarray(from, withoutEol(data, from, end)),
              Math.min(MAX_STREAM_BYTES, budget),
              "deflate",
            );
      if (!inflated) return refusal(found.add("unscannable"));
      budget -= inflated.length;
      scanned++;
      for (const n of names(latin1.decode(inflated))) if (REFUSED.has(n)) found.add(n);
      marks.lastIndex = end;
      marksDone = Math.max(marksDone, base + end);
    }
    const safe = limit();
    marksDone = Math.max(marksDone, base + safe);

    // A token that starts before `safe` is read to its end, which lies in the held-back bytes.
    const tokens = new RegExp(NAME);
    tokens.lastIndex = Math.max(0, namesDone - base);
    for (let m = tokens.exec(text); m !== null && m.index < safe; m = tokens.exec(text)) {
      const n = decodeName(m[0]);
      if (REFUSED.has(n)) found.add(n);
      if (n === "ObjStm") objStmTokens++;
    }
    namesDone = base + safe;
    // Keep the dictionary lookback before the cut so a mark just after it still finds its dictionary.
    const cut = Math.max(0, safe - DICT_LOOKBACK);
    data = data.slice(cut);
    base += cut;
  }
  if (scanned !== objStmTokens) found.add("unscannable");
  return found.size === 0 ? OK : refusal(found);
}

/** One buffer scanned whole: the file as a single chunk. */
export function scanPdf(pdf: Uint8Array): Promise<Check & { found?: string[] }> {
  const chunks: (Uint8Array | null)[] = [pdf, null];
  return scanPdfChunks(async () => chunks.shift() ?? null);
}
