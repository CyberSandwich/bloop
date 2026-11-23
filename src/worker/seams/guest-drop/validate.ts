// What a stored object really is (DROP-02 to DROP-04). Range reads only: the head, the zip end record and
// central directory, or the PDF tail. The one inflate is the content-types part, capped at a few hundred KB.
import type { DropError, FileType } from "../../../shared/protocol.ts";
import { type RangeReader, ZIP_LIMITS } from "./index.ts";
import { checkSizes, entryBytes, hasEndRecord, readCentralDirectory, type ZipEntry } from "./zip.ts";

const HEAD_BYTES = 1024;
const PDF_EOF_WINDOW = 1024;
const text = new TextDecoder("latin1");
const startsWith = (b: Uint8Array, s: string) => s.length <= b.length && text.decode(b.subarray(0, s.length)) === s;

type Verdict = { ok: true; type: FileType } | { ok: false; error: DropError };
const refuse = (error: DropError): Verdict => ({ ok: false, error });

/** What the first bytes say the file is, or null. */
function detect(head: Uint8Array): FileType | null {
  if (startsWith(head, "PK\x03\x04")) return "pptx";
  if (startsWith(head, "%PDF-")) return "pdf";
  return null;
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

/** The detected type must equal the declared one (the extension); anything else is `bad_type`. */
export const validate = async (r: RangeReader, declared: FileType): Promise<Verdict> => {
  const head = await r.read(0, Math.min(r.size, HEAD_BYTES));
  const detected = detect(head);
  if (detected === null || detected !== declared) return refuse("bad_type");
  return detected === "pptx" ? validateDeck(r, head) : validatePdf(r);
};
