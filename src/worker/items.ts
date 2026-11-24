// The items a session holds (docs/interfaces.md section 2.3): files and web links, their order, and the link rule.
// Pure, so the machine, the routes and the unit tests share one definition.
import type { FileType, Item, OpenMode } from "../shared/protocol.ts";
import type { FileRef } from "./machine.ts";

/** A web link the source offered. `url` is what `allowedLink` answered, never the raw input (LINK-01). */
export interface LinkRef {
  kind: "link";
  ref: string;
  url: string;
  title: string;
}
export type FileItemRef = FileRef & { kind: "file" };
export type ItemRef = FileItemRef | LinkRef;

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
    ? { kind: "file", name: i.name, type: i.type, size: i.size ?? null }
    : { kind: "link", url: i.url, title: i.title };
