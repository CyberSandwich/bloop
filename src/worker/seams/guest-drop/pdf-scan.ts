// PDF active-content scan (DROP-13): a name-token scan, not a parser. The bytes are read as Latin-1, every `/Name`
// token is decoded (`#xx` escapes, so `/J#61vaScript` is `/JavaScript`) and compared with the refused set. Object
// streams, where a PDF 1.5 file hides its dictionaries, are inflated and scanned the same way. A stream is an object
// stream when its dictionary names `/ObjStm` or holds both `/N` and `/First`: a reader takes it by those keys alone.
//
// The refused set is action types, not the keys that hold actions: an `/OpenAction` or `/AA` that goes to a page or
// a destination passes (LaTeX hyperref and the Office exporters write them), and one holding a script, a launch, a
// form submission or a jump to another file is refused by that action's own name. A GoToR always names another file;
// a GoToE's target is another file or an embedded one, and embedded files are refused, so both are refused outright.
//
// One scanner reads a PDF as a sequence of chunks of any size, and its verdict does not depend on how the file is cut:
// every decision reads a bounded span past its offset, held back at the buffer's end, except an object stream's data,
// which is read on to its `endstream` up to `MAX_STREAM_BYTES` (one window), the buffer cut to that data first. So the
// buffer stays under two windows plus the hold-back.
//
// Limits: the scan covers names, not stream payloads (an XFA form's XML, an embedded file's bytes, a content stream).
// A name inside a string or comment also matches (fail closed). An object stream is read only when its dictionary is
// exactly the plain form (`/Type /ObjStm`, `/N`, `/First`, `/Length`, `/Extends` and one `/Filter /FlateDecode`), opens
// within `DICT_LOOKBACK` bytes of its `stream` keyword and its data is at most `MAX_STREAM_BYTES`; anything else, and
// any `/ObjStm` token or direct `/First` count (an outline's `/First` is a reference) outside every dictionary read so
// (a keyword followed by a space, a dictionary too far back or split by a second `obj<<`), is refused as
// `unscannable`, as is any `/Encrypt` (its streams are ciphertext). After the first object stream it cannot read the
// scan inflates no more, but reads every name to the end. Names built at run time by a script are the script's own
// business: `/JS` and `/JavaScript` already refuse the script.
import { inflate, latin1 } from "./bytes.ts";
import { type Check, fail, OK } from "./formats.ts";

/** The next chunk of the file in order, or null at its end. */
export type ChunkSource = () => Promise<Uint8Array | null>;

/** The chunk size a caller reading a stored object should ask for. */
export const PDF_WINDOW_BYTES = 8 * 1024 * 1024;

/** Action types that run code, start a program, send data, play rich media or leave the file; and what hides content. */
const REFUSED: ReadonlySet<string> = new Set([
  ...["JS", "JavaScript", "Launch", "SubmitForm", "ImportData", "RichMedia", "GoToR", "GoToE"],
  ...["EmbeddedFile", "EmbeddedFiles", "EF", "FileAttachment", "RF", "XFA", "Encrypt"],
]);
/** The keys of a plain object stream dictionary, and the one filter it may name. */
const OBJSTM_KEYS: ReadonlySet<string> = new Set([
  ...["Type", "ObjStm", "N", "First", "Length", "Filter", "FlateDecode", "Extends"],
]);
/** One object stream's stored and inflated size: a real one holds a few hundred small dictionaries. */
const MAX_STREAM_BYTES = PDF_WINDOW_BYTES;
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
/**
 * A dictionary opening (`obj<<`, white space bounded so every scan sees the whole match) or a stream keyword with its
 * EOL (CR LF, LF, or the CR alone a reader also takes) after white space or `>>`, found in one pass. The left
 * boundary keeps `/ObjStmstream` one name, not a name and a keyword.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is PDF white space
const MARKS = /(?<!end)obj[\x00\t\n\f\r ]{0,64}<<|(?<![^\x00\t\n\f\r >])stream(?:\r\n|\r|\n)/g;
/** What follows `/First` in an outline: a reference. Anything else is an object stream's count. */
const REFERENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is PDF white space
  /[\x00\t\n\f\r ]{0,64}\d{1,10}[\x00\t\n\f\r ]{1,64}\d{1,5}[\x00\t\n\f\r ]{1,64}R(?![^\x00\t\n\f\r /<>[\](){}%])/y;
const ENDSTREAM = Uint8Array.from("endstream", (c) => c.charCodeAt(0));

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

/** Where `endstream` first starts in `b` at or after `from`, or -1. */
function findEnd(b: Uint8Array, from: number): number {
  for (let i = b.indexOf(0x65, from); i !== -1 && i + ENDSTREAM.length <= b.length; i = b.indexOf(0x65, i + 1)) {
    if (ENDSTREAM.every((c, j) => b[i + j] === c)) return i;
  }
  return -1;
}

/** A dictionary a reader takes for an object stream's: typed `/ObjStm`, or holding both `/N` and `/First`. */
function isObjStm(dict: string): boolean {
  const keys = new Set(names(dict));
  return keys.has("ObjStm") || (keys.has("N") && keys.has("First"));
}

const followedByReference = (text: string, at: number): boolean => {
  REFERENCE.lastIndex = at;
  return REFERENCE.test(text);
};

/** True when `dict` is the plain object stream dictionary: allowed keys only, one Flate filter, no array or nesting. */
function plainObjStm(dict: string): boolean {
  const open = dict.indexOf("<<");
  if (open === -1 || dict.indexOf("<<", open + 2) !== -1 || dict.includes("[") || dict.includes("(")) return false;
  const seen = [...names(dict)];
  return seen.every((n) => OBJSTM_KEYS.has(n)) && seen.filter((n) => n === "FlateDecode").length === 1;
}

const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * Every refused name in the file or its object streams, deduplicated and sorted; `unscannable` when a stream could
 * not be read or an `/ObjStm` token lies outside every dictionary read. Offsets are absolute (from the file's start);
 * the buffer `data` begins at `base`. `onBuffer` sees the buffer's size after each read (tests bound it).
 */
export async function scanPdfChunks(
  next: ChunkSource,
  onBuffer?: (bytes: number) => void,
): Promise<Check & { found?: string[] }> {
  const found = new Set<string>();
  let data: Uint8Array = new Uint8Array();
  let base = 0;
  let last = false;
  /** Names before this are scanned; marks before `marksDone` are handled (an object stream's data moves it on). */
  let namesDone = 0;
  let marksDone = 0;
  let dictAt = -1;
  let streams = 0;
  let budget = MAX_TOTAL_INFLATED;
  /** An object stream could not be read: none after it is inflated. */
  let failed = false;
  /** The dictionaries of the object streams read, in file order (disjoint), and the next one a token can fall in. */
  const dicts: [number, number][] = [];
  let dictIndex = 0;
  /** `/ObjStm` offsets no dictionary read holds yet, ascending; a later dictionary may still. */
  let pending: number[] = [];

  const pull = async (): Promise<void> => {
    const chunk = last ? null : await next();
    if (chunk === null) last = true;
    else data = join(data, chunk);
    onBuffer?.(data.length);
  };
  const cut = (to: number): void => {
    if (to <= base) return;
    data = data.slice(to - base);
    base = to;
  };
  const stray = (): void => {
    found.add("unscannable");
    pending = [];
  };
  const tracking = () => !failed && !found.has("unscannable");

  const objStmAt = (at: number): void => {
    while (dictIndex < dicts.length && (dicts[dictIndex] as [number, number])[1] <= at) dictIndex++;
    const d = dicts[dictIndex];
    if (d === undefined) pending.push(at);
    else if (d[0] > at) stray();
  };
  const dictRead = (start: number, end: number): void => {
    dicts.push([start, end]);
    while (pending.length > 0 && (pending[0] as number) < end) {
      if ((pending[0] as number) < start) {
        stray();
        return;
      }
      pending.shift();
    }
  };
  /** A pending token is outside every dictionary once the marks have passed the farthest one that could hold it. */
  const settle = (done: boolean): void => {
    const first = pending[0];
    if (first !== undefined && (done || first + DICT_LOOKBACK < marksDone)) stray();
  };
  const safeEnd = () => (last ? base + data.length : base + Math.max(0, data.length - HOLD_BACK));

  /** Scans the names that start before `to`; `text` must hold the bytes past `to` that the hold-back promises. */
  const scanNames = (text: string, to: number): void => {
    const tokens = new RegExp(NAME);
    tokens.lastIndex = namesDone - base;
    for (let m = tokens.exec(text); m !== null && base + m.index < to; m = tokens.exec(text)) {
      const n = decodeName(m[0]);
      if (REFUSED.has(n)) found.add(n);
      if (tracking() && (n === "ObjStm" || (n === "First" && !followedByReference(text, m.index + m[0].length)))) {
        objStmAt(base + m.index);
      }
    }
    namesDone = Math.max(namesDone, to);
  };

  /** Reads on until `endstream` after `from` arrives or the data is past one stream's cap; its offset, or -1. */
  const readOn = async (from: number): Promise<number> => {
    const need = from + MAX_STREAM_BYTES + ENDSTREAM.length;
    let searched = from;
    for (;;) {
      const end = findEnd(data, searched - base);
      if (end !== -1) return base + end;
      if (last || base + data.length >= need) return -1;
      searched = Math.max(from, base + data.length - ENDSTREAM.length + 1);
      await pull();
    }
  };

  for (let more = true; more; ) {
    if (!last) await pull();
    let text = latin1.decode(data);
    const limit = safeEnd();
    let safe = limit;
    let pulled = false;
    const marks = new RegExp(MARKS);
    marks.lastIndex = Math.max(0, marksDone - base);
    for (let m = failed ? null : marks.exec(text); m !== null && base + m.index < limit; m = marks.exec(text)) {
      const at = base + m.index;
      if (!m[0].startsWith("stream")) {
        dictAt = at;
        continue;
      }
      const dictStart = dictAt;
      dictAt = -1;
      if (dictStart === -1 || at - dictStart > DICT_LOOKBACK) continue;
      const dict = text.slice(dictStart - base, m.index);
      if (!isObjStm(dict)) continue;
      const from = at + m[0].length;
      let end = -1;
      if (streams < MAX_OBJECT_STREAMS && plainObjStm(dict)) {
        end = findEnd(data, from - base);
        if (end !== -1) end += base;
        else if (!last) {
          // The data runs past the buffer: keep only the data, then read on.
          scanNames(text, from);
          cut(from);
          pulled = true;
          end = await readOn(from);
        }
      }
      const inflated =
        end === -1 || end - from > MAX_STREAM_BYTES
          ? null
          : await inflate(
              data.subarray(from - base, withoutEol(data, from - base, end - base)),
              Math.min(MAX_STREAM_BYTES, budget),
              "deflate",
            );
      if (!inflated) {
        failed = true;
        found.add("unscannable");
        break;
      }
      budget -= inflated.length;
      streams++;
      for (const n of names(latin1.decode(inflated))) if (REFUSED.has(n)) found.add(n);
      if (tracking()) dictRead(dictStart, at);
      marksDone = Math.max(marksDone, end);
      if (pulled) {
        // Back to the outer loop from the stream's end, so one stream never makes room for the next.
        safe = end;
        break;
      }
      marks.lastIndex = end - base;
    }
    if (pulled) {
      text = latin1.decode(data);
      if (failed) safe = safeEnd();
    }
    marksDone = Math.max(marksDone, safe);
    scanNames(text, safe);
    // A stream that read on stops the pass at its end: the bytes after it are still to do.
    more = !last || (pulled && !failed);
    if (tracking()) settle(!more);
    // Keep the dictionary lookback before the cut so a mark just after it still finds its dictionary.
    cut(Math.min(namesDone, Math.max(base, safe - DICT_LOOKBACK)));
  }
  return found.size === 0 ? OK : { ...fail("macro_content", "pdf active content"), found: [...found].sort() };
}

/** One buffer scanned whole: the file as a single chunk. */
export function scanPdf(pdf: Uint8Array): Promise<Check & { found?: string[] }> {
  const chunks: (Uint8Array | null)[] = [pdf, null];
  return scanPdfChunks(async () => chunks.shift() ?? null);
}
