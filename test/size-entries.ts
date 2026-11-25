import { readdirSync, readFileSync } from "node:fs";

export interface SizeEntry {
  name: string;
  path: string | string[];
  limit: string;
  gzip?: boolean;
  brotli?: boolean;
}

const dir = new URL("../tools/size/", import.meta.url);

/** Every budget, from tools/size/<area>.json: the same merged list `.size-limit.mjs` hands to size-limit (ADR 0025). */
export const sizeEntries = (): SizeEntry[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => JSON.parse(readFileSync(new URL(file, dir), "utf8")) as SizeEntry[]);
