// An in-memory R2 for the pipeline tests: multipart uploads, whole objects, and a log of every call.
import { type Multipart, PartFailed, type PartRef } from "../../src/worker/uploads/multipart.ts";

const concatAll = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

export interface FakeMultipart extends Multipart {
  objects: Map<string, Uint8Array>;
  open: Map<string, Map<number, Uint8Array>>;
  calls: string[];
  /** Makes the next call of this method throw once. */
  failNext(method: "create" | "part" | "complete" | "head"): void;
}

export function fakeMultipart(): FakeMultipart {
  const objects = new Map<string, Uint8Array>();
  const open = new Map<string, Map<number, Uint8Array>>();
  const calls: string[] = [];
  const failures = new Set<string>();
  let counter = 0;
  const maybeFail = (method: string) => {
    if (failures.delete(method)) throw new Error(`injected ${method} failure`);
  };
  const object = (bytes: Uint8Array) => ({
    size: bytes.length,
    body: new Blob([Buffer.from(bytes)]).stream() as ReadableStream<Uint8Array>,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  });
  return {
    objects,
    open,
    calls,
    failNext: (method) => failures.add(method),
    async create(key) {
      calls.push(`create ${key}`);
      maybeFail("create");
      counter += 1;
      const id = `mp-${counter}`;
      open.set(id, new Map());
      return id;
    },
    async part(key, uploadId, n, body, length) {
      calls.push(`part ${uploadId} ${n}`);
      if (failures.delete("part")) throw new PartFailed("fault");
      const parts = open.get(uploadId);
      if (!parts) throw new PartFailed("gone");
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const bytes = concatAll(chunks);
      if (bytes.length !== length) throw new PartFailed("body");
      parts.set(n, bytes);
      return `"${(key.length * 1000 + n * 7919 + bytes.length).toString(16).padStart(32, "0")}"`;
    },
    async complete(key, uploadId, list: readonly PartRef[]) {
      calls.push(`complete ${uploadId}`);
      maybeFail("complete");
      const parts = open.get(uploadId);
      if (!parts || list.some((p) => !parts.has(p.n))) throw new Error("missing part");
      objects.set(key, concatAll(list.map((p) => parts.get(p.n) as Uint8Array)));
      open.delete(uploadId);
    },
    async abort(_key, uploadId) {
      calls.push(`abort ${uploadId}`);
      return open.delete(uploadId);
    },
    async head(key) {
      calls.push(`head ${key}`);
      maybeFail("head");
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async get(key, range) {
      calls.push(`get ${key}`);
      const bytes = objects.get(key);
      if (!bytes) return null;
      return object(range ? bytes.subarray(range.offset, range.offset + range.length) : bytes);
    },
    async delete(key) {
      calls.push(`delete ${key}`);
      objects.delete(key);
    },
  };
}
