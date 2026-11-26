// The R2 slice uploads use: a multipart upload, a head, a range read and a delete, over the platform binding. The one
// cast from the binding is `bucketFor` (deps.ts). Callers charge the spend meter (class A per mint request, class B per
// validation); nothing here counts. An upload id only ever comes from D1, never from a client.
export interface PartRef {
  n: number;
  etag: string;
}

/** What the platform binding offers, as far as uploads use it. */
export interface UploadBucket {
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    uploadPart(n: number, value: ReadableStream<Uint8Array>): Promise<{ partNumber: number; etag: string }>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
    abort(): Promise<void>;
  };
  head(key: string): Promise<{ size: number } | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

// Declared here because the Node tsconfig (tests) has no Workers types; undefined outside the Workers runtime.
declare const FixedLengthStream: (new (length: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;

/**
 * Why a part was not stored: `body`, the client's body was not the declared length; `gone`, R2 no longer has the
 * multipart; `fault`, anything else, worth a retry.
 */
export class PartFailed extends Error {
  constructor(readonly why: "body" | "gone" | "fault") {
    super(`part not stored: ${why}`);
  }
}

/** R2's NoSuchUpload (code 10024, unverified against the live binding's message). */
const isGone = (error: unknown): boolean => /NoSuchUpload|\b10024\b/i.test(String(error));

export interface Multipart {
  /** Opens a multipart upload and returns R2's upload id. */
  create(key: string): Promise<string>;
  /** Stores one part from a body of exactly `length` bytes and returns R2's ETag; any failure is a `PartFailed`. */
  part(key: string, uploadId: string, n: number, body: ReadableStream<Uint8Array>, length: number): Promise<string>;
  /** Joins the parts; every part but the last must be the same size, or R2 refuses. */
  complete(key: string, uploadId: string, parts: readonly PartRef[]): Promise<void>;
  /** An upload that is already gone aborts as a no-op; true when R2 aborted one. */
  abort(key: string, uploadId: string): Promise<boolean>;
  head(key: string): Promise<{ size: number } | null>;
  get(key: string, range?: { offset: number; length: number }): ReturnType<UploadBucket["get"]>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
}

export function multipartOver(bucket: UploadBucket): Multipart {
  return {
    async create(key) {
      return (await bucket.createMultipartUpload(key)).uploadId;
    },
    async part(key, uploadId, n, body, length) {
      if (typeof FixedLengthStream === "undefined") throw new Error("needs the Workers runtime");
      const fixed = new FixedLengthStream(length);
      // Counted before the fixed-length stream, so a body of the wrong length tells itself apart from an R2 fault
      // (either one errors both sides of the pipe).
      let seen = 0;
      let ended = false;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          seen += chunk.byteLength;
          out.enqueue(chunk);
        },
        flush() {
          ended = true;
        },
      });
      const piped = body.pipeThrough(counter).pipeTo(fixed.writable);
      const stored = bucket.resumeMultipartUpload(key, uploadId).uploadPart(n, fixed.readable);
      const [pipe, put] = await Promise.allSettled([piped, stored]);
      if (pipe.status === "fulfilled" && put.status === "fulfilled") return put.value.etag;
      if (seen > length || (ended && seen !== length)) throw new PartFailed("body");
      throw new PartFailed(put.status === "rejected" && isGone(put.reason) ? "gone" : "fault");
    },
    async complete(key, uploadId, parts) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
    },
    async abort(key, uploadId) {
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
        return true;
      } catch {
        return false;
      }
    },
    head: (key) => bucket.head(key),
    get: (key, range) => bucket.get(key, range ? { range } : undefined),
    delete: (key) => bucket.delete(key),
  };
}
