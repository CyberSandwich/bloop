// What the library routes send: a file row as the page reads it, and the list answer around it (docs/library.md).
// Null fields are left out, so a row names only what is true of it.
import { type FileRow, UP_NEXT_MAX } from "./store.ts";

export interface WireRow {
  id: string;
  name: string;
  ext: string;
  bytes: number;
  status: string;
  refusal?: string;
  updatedAt: number;
  lastPresentedAt?: number;
  selected: boolean;
  trashedAt?: number;
  purgeAfter?: number;
  disabled: boolean;
  derived: { state: string; done?: number; total?: number; pages?: number; fontsMissing?: string[] };
  thumb?: string;
}

export function wireRow(
  row: FileRow,
  thumb: string | null,
  progress: { done: number; total: number } | undefined,
): WireRow {
  const { derived } = row;
  const out: WireRow = {
    id: row.id,
    name: row.name,
    ext: row.ext,
    bytes: row.bytes,
    status: row.status,
    updatedAt: row.updatedAt,
    selected: row.selected,
    disabled: row.disabled,
    derived: { state: derived.state },
  };
  if (row.refusal !== null) out.refusal = row.refusal;
  if (row.lastPresentedAt !== null) out.lastPresentedAt = row.lastPresentedAt;
  if (row.trashedAt !== null) out.trashedAt = row.trashedAt;
  if (row.purgeAfter !== null) out.purgeAfter = row.purgeAfter;
  if (derived.pages !== null) out.derived.pages = derived.pages;
  if (derived.fontsMissing.length > 0) out.derived.fontsMissing = derived.fontsMissing;
  if (derived.state === "preparing" && progress) {
    out.derived.done = progress.done;
    out.derived.total = progress.total;
  }
  if (thumb) out.thumb = thumb;
  return out;
}

/** The limits the page shows and enforces; they travel in the answer so the client restates no number. */
export const limitsWire = (config: { trashDays: number; maxFileBytes: number }) => ({
  upNext: UP_NEXT_MAX,
  trashDays: config.trashDays,
  maxFileBytes: config.maxFileBytes,
});

/** A strong validator over the answer's bytes, so a refresh that changed nothing is a 304. */
export async function etagOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `"${Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}
