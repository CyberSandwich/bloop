// The items a session holds (docs/interfaces.md section 2.3): files and web links, their order, and the link rule.
// Pure, so the machine, the routes and the unit tests share one definition.
import type { Item } from "../shared/protocol.ts";
import type { FileRef } from "./machine.ts";

/** A web link the source offered. Only `linkAllowed` URLs get this far (LINK-01). */
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

/** True for an https URL on an allowed host, with no credentials and no port. Parsed, never pattern-matched. */
export function linkAllowed(raw: string): boolean {
  if (raw.length > MAX_URL_CHARS) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    LINK_HOSTS.includes(url.hostname)
  );
}

/** Files by name, then links by title: the order every page shows and every item index names. */
export function orderItems(items: readonly ItemRef[]): ItemRef[] {
  const label = (i: ItemRef) => (i.kind === "file" ? i.name : i.title);
  const rank = (i: ItemRef) => (i.kind === "file" ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b), "en"));
}

/** The index of the item an approval launches: the first file. -1 when the session holds links only. */
export const launchIndex = (items: readonly ItemRef[]): number => items.findIndex((i) => i.kind === "file");

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
