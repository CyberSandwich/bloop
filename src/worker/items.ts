// The items a session holds (docs/interfaces.md section 2.3): files and web links, their order, and the link rule.
// Pure, so the machine, the routes and the unit tests share one definition.
import { z } from "zod";
import { pagesOf } from "../../public/js/core/demo.js";
import { orderItems as byLabel, tuneOf } from "../../public/js/shared/session.js";
import type {
  DerivedFlags,
  FileType,
  Item,
  ItemKind,
  Kind,
  Mode,
  OpenMode,
  PhoneItemExtra,
  Shown,
} from "../shared/protocol.ts";
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

/** The viewer each type is shown in. A `Record`, so a type added to `FileType` fails the typecheck until it has one. */
const KINDS: Readonly<Record<FileType, ItemKind>> = {
  pptx: "deck",
  pdf: "pdf",
  jpg: "image",
  png: "image",
  mp4: "video",
  mov: "video",
};

/** What a file of this type is shown as: derived on the server, never taken from a client. */
// Own keys only: a stored type such as "constructor" must not read Object.prototype.
export const kindOf = (type: FileType): ItemKind | null => (Object.hasOwn(KINDS, type) ? KINDS[type] : null);

/** The viewer an item opens in: the stored kind, or its type's for an item stored before kinds were. */
export const showOf = (file: FileRef): ItemKind | null => file.show ?? kindOf(file.type);

const MAX_FONTS = 50;
const MAX_FONT_CHARS = 100;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

/** Exactly the four screen-safe flags (PAIR-16): any other key, or a value of another type, fails. */
export const validDerived = (v: unknown): v is DerivedFlags =>
  isRecord(v) &&
  exactKeys(v, ["slides", "pdf", "pages", "motion"]) &&
  typeof v.slides === "boolean" &&
  typeof v.pdf === "boolean" &&
  typeof v.motion === "boolean" &&
  (v.pages === null || (Number.isSafeInteger(v.pages) && (v.pages as number) >= 1));

/** The phone-only extras: a notes flag and at most 50 font names of at most 100 characters each. */
export const validExtra = (v: unknown): v is PhoneItemExtra =>
  isRecord(v) &&
  exactKeys(v, ["notes", "fontsMissing"]) &&
  typeof v.notes === "boolean" &&
  Array.isArray(v.fontsMissing) &&
  v.fontsMissing.length <= MAX_FONTS &&
  v.fontsMissing.every((f) => typeof f === "string" && f.length <= MAX_FONT_CHARS);

/** Up Next's list: at least one item, every one a library file (a live list holds nothing else, so no link). */
export const isUpNext = (items: readonly ItemDraft[]): boolean =>
  items.length > 0 && items.every((i) => i.kind === "file" && i.source === "library");

/** A library file's ref: its 22-character id and its version. */
export const validLibraryRef = (ref: string): boolean => /^[A-Za-z0-9_-]{22}:\d{1,6}$/.test(ref);

/**
 * The order a session stores. Up Next's list keeps the caller's order (ADR 0009); any other list, links alone
 * included, is files by name, then links by title.
 */
export function orderItems<T extends ItemDraft>(items: readonly T[]): T[] {
  return isUpNext(items) ? [...items] : byLabel(items);
}

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

/** How many pages a file shows: its converted pages, the demo account's pre-rendered ones for the deck, else one. */
export const pageCount = (file: FileItemRef, view: { mode: Mode; kind: Kind | null }): number =>
  file.derived?.pages ?? pagesOf(itemView(file), view)?.length ?? 1;

/** A bound, not a page count: `shownFault` checks the item's real pages. */
const MAX_PAGE = 1000;

/** `Shown`'s one shape check: the remote's body extends it, and the schema step repairs stored data with it. */
export const shownSchema = z
  .object({
    item: z.string().min(1).max(32),
    page: z.number().int().min(1).max(MAX_PAGE),
    present: z.boolean(),
    play: z.boolean().optional(),
    sound: z.enum(["on", "off", "blocked"]).optional(),
    via: z.enum(["viewer", "app"]).optional(),
  })
  .strict();

/**
 * Why `shown` cannot stand in this session, or null when it can: the item must be a FILE in the list by id, so a link
 * (LINK-01) or an unknown id (PAIR-11) is `file_not_found`, and the page must be one of the item's. `link` also takes a
 * link's id, at page 1: the screen's own report that it shows a link card, never a command to open one. `via` is only
 * for a deck that has converted slides, the one item a viewer and an app can both show.
 */
export function shownFault(
  items: readonly ItemRef[],
  shown: Shown,
  view: { mode: Mode; kind: Kind | null },
  link = false,
): "file_not_found" | "bad_request" | null {
  const item = items.find((i) => i.id === shown.item);
  if (!item || (item.kind === "link" && !link)) return "file_not_found";
  const { page } = shown;
  if (shown.via !== undefined && !(item.kind === "file" && showOf(item) === "deck" && item.derived?.slides)) {
    return "bad_request";
  }
  return Number.isInteger(page) && page >= 1 && page <= (item.kind === "file" ? pageCount(item, view) : 1)
    ? null
    : "bad_request";
}

/** Absent play state fields read as their defaults, so an old sender's command equals a new one's. */
export const sameShown = (a: Shown | null, b: Shown): boolean =>
  a !== null &&
  a.item === b.item &&
  a.page === b.page &&
  a.present === b.present &&
  a.via === b.via &&
  tuneOf(a).play === tuneOf(b).play &&
  tuneOf(a).sound === tuneOf(b).sound;

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

/**
 * What a page may see of an item: no source id, no ref (SRC-01). Of conversion only the four screen-safe flags, picked
 * by name, so a stored object holding more can never pass it through (PAIR-16).
 */
export const itemView = (i: ItemRef): Item => {
  if (i.kind === "link") return { kind: "link", id: i.id, url: i.url, title: i.title };
  const d = i.derived;
  return {
    kind: "file",
    id: i.id,
    name: i.name,
    type: i.type,
    size: i.size ?? null,
    show: showOf(i) ?? undefined,
    derived: d ? { slides: d.slides, pdf: d.pdf, pages: d.pages, motion: d.motion } : null,
  };
};
