import merged from "../.size-limit.mjs";

export interface SizeEntry {
  name: string;
  path: string | string[];
  limit: string;
  gzip?: boolean;
  brotli?: boolean;
}

/** Every budget, from tools/size/<area>.json (ADR 0025), merged once in `.size-limit.mjs`. */
export const sizeEntries = (): SizeEntry[] => merged as SizeEntry[];
