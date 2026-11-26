// What a stored object really is, once it is whole: the digests the library keeps and the validators' verdict, for
// library and guest alike. A small object is read once and everything runs over that one buffer; a large one is
// streamed once for its digests and the validators range-read the few parts they need (read-plan.ts bounds them).
import { crc32 } from "../crc32.ts";
import type { FormatType, Refusal } from "../seams/guest-drop/formats.ts";
import type { RangeReader } from "../seams/guest-drop/index.ts";
import { PDF_WINDOW_BYTES } from "../seams/guest-drop/pdf-scan.ts";
import { READ_PLAN } from "../seams/guest-drop/read-plan.ts";
import { validate } from "../seams/guest-drop/validate.ts";
import type { Multipart } from "./multipart.ts";

// Declared here because the Node tsconfig (tests) has no Workers types; undefined outside the Workers runtime.
declare const crypto: Crypto & {
  DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
};

export type Checked =
  | { ok: true; type: FormatType; sha256: string; crc32: number }
  | { ok: false; error: Refusal }
  /** Not decided: the deadline passed or the R2 operation cap refused the reads. The file stays `checking`. */
  | { ok: "later" };

export interface CheckOptions {
  /** Wall-clock time (ms) after which the check stops and answers `later`. */
  deadline: number;
  now: () => number;
  /** Charges `n` class B reads; false when the cap or the guard refuses them. */
  charge: (n: number) => Promise<boolean>;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** The most reads a large object's validation can spend: the stream, the plan's ranges, or a PDF's windows. */
export const readBudget = (size: number): number =>
  size <= READ_PLAN.smallObjectBytes ? 1 : 1 + Math.max(READ_PLAN.maxReads, Math.ceil(size / PDF_WINDOW_BYTES) + 4);

export async function checkStored(
  m: Multipart,
  key: string,
  size: number,
  declared: FormatType,
  options: CheckOptions,
): Promise<Checked> {
  if (!(await options.charge(readBudget(size)))) return { ok: "later" };
  if (size <= READ_PLAN.smallObjectBytes) {
    const object = await m.get(key);
    if (!object) return { ok: false, error: "upload_aborted" };
    const bytes = new Uint8Array(await object.arrayBuffer());
    const verdict = await validate(over(bytes), declared);
    if (!verdict.ok) return verdict;
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    return { ok: true, type: verdict.type, sha256, crc32: crc32(bytes) };
  }
  const digests = await streamDigests(m, key, options);
  if (digests === null) return { ok: "later" };
  const verdict = await validate(ranged(m, key, size), declared);
  return verdict.ok ? { ok: true, type: verdict.type, ...digests } : verdict;
}

const over = (bytes: Uint8Array): RangeReader => ({
  size: bytes.length,
  read: async (offset, length) => bytes.subarray(offset, offset + length),
});

const ranged = (m: Multipart, key: string, size: number): RangeReader => ({
  size,
  read: async (offset, length) => {
    if (length <= 0 || offset >= size) return new Uint8Array();
    const part = await m.get(key, { offset, length });
    return part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array();
  },
});

/** One pass over the object: SHA-256 (natively) and CRC-32 of every byte. Null when the deadline passes first. */
async function streamDigests(
  m: Multipart,
  key: string,
  options: CheckOptions,
): Promise<{ sha256: string; crc32: number } | null> {
  if (!crypto.DigestStream) throw new Error("needs the Workers runtime");
  const object = await m.get(key);
  if (!object) return null;
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const reader = object.body.getReader();
  let crc = 0;
  for (;;) {
    if (options.now() > options.deadline) {
      await reader.cancel();
      await writer.abort();
      return null;
    }
    const { done, value } = await reader.read();
    if (done) break;
    crc = crc32(value, crc);
    await writer.write(value);
  }
  await writer.close();
  return { sha256: hex(await digest.digest), crc32: crc };
}
