// What the library routes send: a file row as the page reads it, and the list answer around it (docs/library.md).
// Null fields are left out, so a row names only what is true of it.
import { type FileRow, UP_NEXT_MAX } from "./store.ts";

/** What the row's glyph and label say it is (ux/library.md, Row): one word per glyph the page draws. */
export type FileKind = "deck" | "document" | "sheet" | "image" | "video";

// transitional: U: the extension-to-kind table moves into formats.ts (FORMATS), the one list of types
const KINDS: Readonly<Record<string, FileKind>> = {
  pptx: "deck",
  ppt: "deck",
  pdf: "document",
  doc: "document",
  docx: "document",
  txt: "document",
  md: "document",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  jpg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
};

/** A type the table does not name reads as a document, so a new format shows a sensible row before its entry lands. */
export const kindOf = (ext: string): FileKind => KINDS[ext] ?? "document";

export interface WireRow {
  id: string;
  name: string;
  ext: string;
  kind: FileKind;
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
    kind: kindOf(row.ext),
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
export const limitsWire = (config: { trashDays: number; maxFileBytes: number; largeFileChoiceBytes: number }) => ({
  upNext: UP_NEXT_MAX,
  trashDays: config.trashDays,
  maxFileBytes: config.maxFileBytes,
  largeFileChoiceBytes: config.largeFileChoiceBytes,
});
