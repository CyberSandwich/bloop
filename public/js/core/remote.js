// The remote's state, no DOM (core/remote-ui.js draws it). While a command is on its way it shows the last tap, then
// the server's `shown` (PAIR-13).
/** @import {ErrorCode, Item, PhoneView, Shown, ShownCommand} from "../../../src/shared/protocol.ts" */
import { nextSeq, pagesOf, stepPage } from "./demo.js";
import { firstFile, onStage } from "./states.js";

/** The stored `shown`, else the first file's first page, as the screen starts. */
export function current(/** @type {PhoneView} */ view) {
  const first = firstFile(view.items);
  return view.shown ?? (first ? { item: first.id, page: 1, present: false } : null);
}

/** Pages, a photo or a video; a link or a guest's deck is a card. */
export const canPresent = (/** @type {Item} */ item, /** @type {PhoneView} */ view) =>
  !!pagesOf(item, view) || onStage(item);

/**
 * The command a tap makes, or null if it changes nothing. A new item starts at page 1, playing, presenting on if it
 * can. Sound from the screen's blocked asks for sound.
 * @param {PhoneView} view
 * @param {Shown} at
 * @param {{item: string} | {step: number} | {present: true} | {play: true} | {sound: true}} tap
 * @returns {Shown | null}
 */
export function command(view, at, tap) {
  if ("item" in tap) {
    const item = view.items.find((x) => x.id === tap.item);
    if (item?.kind !== "file") return null;
    const next = { ...at, item: item.id, page: 1, present: at.present && canPresent(item, view), play: true };
    return item.id === at.item && at.page === 1 && next.present === at.present ? null : next;
  }
  const item = view.items.find((x) => x.id === at.item);
  if (!item) return null;
  if ("play" in tap) return { ...at, play: at.play === false };
  if ("sound" in tap) return { ...at, sound: (at.sound ?? "on") === "on" ? "off" : "on" };
  if ("present" in tap) return canPresent(item, view) ? { ...at, present: !at.present } : null;
  const pages = pagesOf(item, view);
  const page = pages ? stepPage(at.page - 1, tap.step, pages.length) + 1 : at.page;
  return page === at.page ? null : { ...at, page };
}

/**
 * @typedef {{ok: true, value: PhoneView} | {ok: false, error: ErrorCode}} Answer
 * @param {{
 *   view: () => PhoneView | null,
 *   post: (command: ShownCommand) => Promise<Answer>,
 *   adopt: (view: PhoneView) => void,
 *   refused: (code: ErrorCode) => void,
 *   paint: () => void,
 *   now?: () => number,
 * }} io adopt renders, so the remote repaints
 */
export function createRemote(io) {
  let last = 0;
  let pending = 0;
  /** @type {Shown | null} */
  let mine = null;
  const at = () => {
    const view = io.view();
    return pending ? mine : view && current(view);
  };
  return {
    at,
    async tap(/** @type {Parameters<typeof command>[2]} */ tap) {
      const view = io.view();
      const from = at();
      const next = view && from && command(view, from, tap);
      if (!next) return;
      mine = next;
      pending += 1;
      io.paint();
      last = nextSeq(Math.max(last, view.seq), io.now?.());
      const res = await io.post({ ...next, seq: last });
      pending -= 1;
      // A stale seq answers with the current view; an equal `v` is the state held.
      if (res.ok && res.value.v > (io.view()?.v ?? -1)) return io.adopt(res.value);
      if (!res.ok) io.refused(res.error);
      io.paint();
    },
  };
}
