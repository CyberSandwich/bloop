// An in-memory library bucket: the list, delete, head, get and put the library code uses, ordered by key like the real one.
import type { LibraryBucket } from "../../src/worker/library/bucket.ts";

export interface FakeBucket {
  objects: Map<string, Uint8Array<ArrayBuffer>>;
  /** Called before each delete; a test throws from it to model a crash. */
  beforeDelete: (keys: string[]) => void;
  /** Keys read by `get`, in order. */
  reads: string[];
  bucket: LibraryBucket;
}

const bytesOf = (value: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);

export function fakeBucket(initial: Record<string, string | Uint8Array> = {}): FakeBucket {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, bytesOf(v)]));
  const state: FakeBucket = {
    objects,
    reads: [],
    beforeDelete: () => {},
    bucket: {
      async list(options = {}) {
        const prefix = options.prefix ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const limit = options.limit ?? 1000;
        const folded = options.delimiter
          ? new Set(
              keys.flatMap((k) =>
                k.includes(options.delimiter as string, prefix.length)
                  ? [k.slice(0, k.indexOf(options.delimiter as string, prefix.length) + 1)]
                  : [],
              ),
            )
          : new Set<string>();
        const flat = keys.filter((k) => !options.delimiter || !k.includes(options.delimiter, prefix.length));
        return {
          objects: flat.slice(0, limit).map((key) => ({ key, size: objects.get(key)?.length ?? 0 })),
          truncated: flat.length > limit,
          delimitedPrefixes: [...folded],
        };
      },
      async delete(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        state.beforeDelete(list);
        for (const k of list) objects.delete(k);
      },
      async head(key) {
        const body = objects.get(key);
        return body ? { size: body.length } : null;
      },
      async get(key, options) {
        const body = objects.get(key);
        if (!body) return null;
        state.reads.push(key);
        const part = options?.range
          ? body.slice(options.range.offset, options.range.offset + options.range.length)
          : body;
        return {
          body: new Blob([part]).stream(),
          size: body.length,
          text: async () => new TextDecoder().decode(part),
        };
      },
      async put(key, value) {
        if (value instanceof ReadableStream) {
          objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
        } else {
          objects.set(key, bytesOf(value));
        }
      },
    },
  };
  return state;
}
