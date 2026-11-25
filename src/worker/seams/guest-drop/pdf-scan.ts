// PDF active-content scan (DROP-13): a name-token scan, not a parser. The bytes are read as Latin-1, every `/Name`
// token is decoded (`#xx` escapes, so `/J#61vaScript` is `/JavaScript`) and compared with the refused set. Object
// streams (`/ObjStm`), where a PDF 1.5 file hides its dictionaries, are inflated and scanned the same way.
//
// Limits: a name inside a string or comment also matches (fail closed). An object stream with a filter other than a
// lone FlateDecode, one that will not inflate within the caps, or any `/Encrypt` dictionary (its streams are
// ciphertext) cannot be read, so it is refused as unscannable. Names built at run time by a script are the
// script's own business: `/JS` and `/JavaScript` already refuse the script. The caller bounds `pdf.length`.
import { type Check, fail, OK } from "./formats.ts";

const REFUSED: ReadonlySet<string> = new Set([
  ...["JS", "JavaScript", "Launch", "EmbeddedFile", "EmbeddedFiles", "OpenAction"],
  "Encrypt",
]);
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 32 * 1024 * 1024;

const latin1 = new TextDecoder("latin1");
const NAME = /\/[^\s/<>[\](){}%]+/g;
const STREAM_BODY = /(?<!end)stream\r?\n/g;
/** Filters that change the bytes: an object stream is read only when Flate is the one and only. */
const OTHER_FILTERS = ["ASCIIHexDecode", "ASCII85Decode", "LZWDecode", "RunLengthDecode", "Crypt", "DecodeParms"];

const decodeName = (token: string): string =>
  token.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

const namesIn = (text: string): string[] => [...text.matchAll(NAME)].map((m) => decodeName(m[0]));

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

/** The end of a stream's data: the EOL before `endstream` is not part of it, and inflate rejects trailing bytes. */
function withoutEol(pdf: Uint8Array, from: number, to: number): number {
  if (to - from >= 2 && pdf[to - 2] === 0x0d && pdf[to - 1] === 0x0a) return to - 2;
  return to > from && (pdf[to - 1] === 0x0a || pdf[to - 1] === 0x0d) ? to - 1 : to;
}

/** Every refused name in the file or its object streams, deduplicated; `unscannable` when a stream could not be read. */
export async function scanPdf(pdf: Uint8Array): Promise<Check & { found?: string[] }> {
  const text = latin1.decode(pdf);
  const found = new Set(namesIn(text).filter((n) => REFUSED.has(n)));
  let budget = MAX_TOTAL_INFLATED;
  for (const m of text.matchAll(STREAM_BODY)) {
    const dictStart = text.lastIndexOf("obj", m.index);
    const dict = new Set(namesIn(text.slice(Math.max(dictStart, 0), m.index)));
    if (!dict.has("ObjStm")) continue;
    const end = text.indexOf("endstream", m.index);
    const from = m.index + m[0].length;
    const raw = pdf.subarray(from, withoutEol(pdf, from, end === -1 ? pdf.length : end));
    if (!dict.has("FlateDecode") || OTHER_FILTERS.some((f) => dict.has(f))) {
      found.add("unscannable");
      continue;
    }
    const inflated = await inflate(raw, Math.min(MAX_STREAM_BYTES, budget));
    if (!inflated) {
      found.add("unscannable");
      continue;
    }
    budget -= inflated.length;
    for (const n of namesIn(latin1.decode(inflated))) if (REFUSED.has(n)) found.add(n);
  }
  return found.size === 0 ? OK : { ...fail("macro_content", "pdf active content"), found: [...found] };
}
