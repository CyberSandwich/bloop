// The items a session holds (docs/interfaces.md section 2.3): files and web links, their order, and the link rule.
// Pure, so the machine, the routes and the unit tests share one definition.
import { z } from "zod";
import { pagesOf } from "../../public/js/core/demo.js";
import type { FileType, Item, Kind, Mode, OpenMode, Shown } from "../shared/protocol.ts";
import type { FileRef } from "./machine.ts";

/** A web link the source offered. `url` is what `allowedLink` answered, never the raw input (LINK-01). */
export interface LinkRef {
  kind: "link";
  id: string;
  ref: string;
  url: string;
  title: string;
}
export type FileItemRef = FileRef & { kind: "file"; id: string };
export type ItemRef = FileItemRef | LinkRef;
/** An item before approval gives it an id. */
export type ItemDraft = Omit<FileItemRef, "id"> | Omit<LinkRef, "id">;

/** The most items one session holds. */
export const MAX_ITEMS = 12;

/** Hosts a link item may point at. A link is a card the presenter clicks, never a frame (LINK-01). */
export const LINK_HOSTS: readonly string[] = ["www.vevox.com"];
const MAX_URL_CHARS = 2048;

/**
 * The normalized URL (`url.href`) for an https URL on an allowed host, with no credentials and no explicit non-default
 * port; else null. Parsed, never pattern-matched, and the caller keeps only the answer: what was checked is what is shown.
 */
export function allowedLink(raw: string): string | null {
  if (raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const allowed =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    LINK_HOSTS.includes(url.hostname);
  return allowed && url.href.length <= MAX_URL_CHARS ? url.href : null;
}

export { orderItems } from "../../public/js/shared/session.js";

/** The id an item holds from approval on: its place in the approved list, written once and never recomputed. */
export const itemId = (index: number): string => `i${index + 1}`;

const hasId = (item: ItemDraft | ItemRef): item is ItemRef => "id" in item && typeof item.id === "string";

/**
 * Ids for a list already in `orderItems` order. A list that already holds ids (a guest's file, given its id at
 * `upload.done` and approved at `open.click`) keeps them, so an item's id never changes, whatever later reorders the
 * list. A list with any item lacking an id is numbered whole, so no two items share one.
 */
export const withIds = (items: readonly (ItemDraft | ItemRef)[]): ItemRef[] =>
  items.every(hasId) ? [...items] : items.map((item, i) => ({ ...item, id: itemId(i) }));

/** The file item with this id, or null for a link or an unknown id (PAIR-11, LINK-01). */
export const fileById = (items: readonly ItemRef[], id: string): FileItemRef | null => {
  const item = items.find((i) => i.id === id);
  return item?.kind === "file" ? item : null;
};

/** How many pages a file shows: the demo account's pre-rendered pages for a deck or PDF, else one. */
export const pageCount = (file: FileItemRef, view: { mode: Mode; kind: Kind | null }): number =>
  pagesOf(itemView(file), view)?.length ?? 1;

/** A bound, not a page count: `shownFault` checks the item's real pages. */
const MAX_PAGE = 1000;

/** `Shown`'s one shape check: the remote's body extends it, and the schema step repairs stored data with it. */
export const shownSchema = z
  .object({
    item: z.string().min(1).max(32),
    page: z.number().int().min(1).max(MAX_PAGE),
    present: z.boolean(),
  })
  .strict();

/**
 * Why `shown` cannot stand in this session, or null when it can: the item must be a FILE in the list by id, so a link
 * (LINK-01) or an unknown id (PAIR-11) is `file_not_found`, and the page must be one of the item's.
 */
export function shownFault(
  items: readonly ItemRef[],
  shown: Shown,
  view: { mode: Mode; kind: Kind | null },
): "file_not_found" | "bad_request" | null {
  const file = fileById(items, shown.item);
  if (!file) return "file_not_found";
  const { page } = shown;
  return Number.isInteger(page) && page >= 1 && page <= pageCount(file, view) ? null : "bad_request";
}

export const sameShown = (a: Shown | null, b: Shown): boolean =>
  a !== null && a.item === b.item && a.page === b.page && a.present === b.present;

/** The index of the item an approval launches: the first file. -1 when the session holds links only. */
export const launchIndex = (items: readonly ItemRef[]): number => items.findIndex((i) => i.kind === "file");

/**
 * The purpose a link for this type really serves. Download is a download for every type. A PDF file is its own
 * inline view, an image is only ever shown (`view`), and a deck's view is its PDF rendition.
 */
export function effectivePurpose(type: FileType, purpose: OpenMode): OpenMode {
  if (purpose === "download") return purpose;
  if (type === "pdf") return "pdf";
  if (type === "pptx") return purpose === "view" ? "pdf" : purpose;
  return "view";
}

/** The file at `index`, or null for a link or an index out of range. */
export function fileAt(items: readonly ItemRef[], index: number): FileItemRef | null {
  const item = items[index];
  return item?.kind === "file" ? item : null;
}

/** What a page may see of an item: no source id, no ref (SRC-01). */
export const itemView = (i: ItemRef): Item =>
  i.kind === "file"
    ? { kind: "file", id: i.id, name: i.name, type: i.type, size: i.size ?? null }
    : { kind: "link", id: i.id, url: i.url, title: i.title };
