// Byte helpers shared by the guest-drop validators (validate.ts, formats.ts, pdf-scan.ts).

export const latin1 = new TextDecoder("latin1");

export const ascii = (b: Uint8Array, at: number, length: number): string => latin1.decode(b.subarray(at, at + length));

export const startsWith = (b: Uint8Array, s: string): boolean => s.length <= b.length && ascii(b, 0, s.length) === s;

/** The major brand of an ISO base media file (`ftyp` at offset 4), or null. */
export const majorBrand = (head: Uint8Array): string | null =>
  head.length >= 12 && ascii(head, 4, 4) === "ftyp" ? ascii(head, 8, 4) : null;

/** Inflates `data` (zlib or raw deflate) up to `limit` bytes; null when it is corrupt, has trailing bytes or is larger. */
export async function inflate(
  data: Uint8Array,
  limit: number,
  format: "deflate" | "deflate-raw",
): Promise<Uint8Array | null> {
  // A stream over `data` itself and one copy of the output: a Blob on either side would copy the bytes again.
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(format)).getReader();
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
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
