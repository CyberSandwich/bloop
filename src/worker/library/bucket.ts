// The slice of the library bucket the library code uses. The platform binding satisfies it (`bucketOf`); the Node
// tsconfig that tests use has no Workers types, so no module a test imports may name R2Bucket.
export interface LibraryBucket {
  list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }): Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; text(): Promise<string> } | null>;
  put(key: string, value: ReadableStream<Uint8Array> | Uint8Array | string): Promise<unknown>;
}

export const bucketOf = (binding: unknown): LibraryBucket => binding as LibraryBucket;
