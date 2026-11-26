// The R2 slice uploads use: a multipart upload, a head, a range read and a delete, over the platform binding. The one
// cast from the binding is `bucketFor`. Callers charge the spend meter (class A per mint request, class B per
// validation); nothing here counts. An upload id only ever comes from D1, never from a client.
import type { Env } from "../env.ts";

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

/** The one cast from a binding to the slice above. */
export const bucketFor = (env: Pick<Env, "LIBRARY" | "GUEST_FILES">, which: "library" | "guest"): UploadBucket =>
  (which === "library" ? env.LIBRARY : env.GUEST_FILES) as unknown as UploadBucket;

// Declared here because the Node tsconfig (tests) has no Workers types; undefined outside the Workers runtime.
declare const FixedLengthStream: (new (length: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;

export interface Multipart {
  /** Opens a multipart upload and returns R2's upload id. */
  create(key: string): Promise<string>;
  /** Stores one part from a body of exactly `length` bytes (a longer or shorter body errors) and returns R2's ETag. */
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
      const piped = body.pipeTo(fixed.writable);
      const stored = bucket.resumeMultipartUpload(key, uploadId).uploadPart(n, fixed.readable);
      const [pipe, put] = await Promise.allSettled([piped, stored]);
      if (pipe.status === "rejected") throw pipe.reason;
      if (put.status === "rejected") throw put.reason;
      return put.value.etag;
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
