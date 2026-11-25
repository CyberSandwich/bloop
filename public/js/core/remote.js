// The phone's remote, its state (no DOM, so the unit tests run it in Node; core/remote-ui.js draws it). A command is
// absolute and carries the phone's seq (PAIR-13). A tap shows at once: while any command is on its way the remote shows
// the last tap, never a push or an earlier answer; once all are back the server's `shown` is the truth again.
/** @import {ErrorCode, Item, PhoneView, Shown, ShownCommand} from "../../../src/shared/protocol.ts" */
import { nextSeq, pagesOf, stepPage } from "./demo.js";
import { firstFile, onStage } from "./states.js";

/** What the screen shows: the stored `shown`, or before any command its first file's first page, as the screen does. */
export function current(/** @type {PhoneView} */ view) {
  const first = firstFile(view.items);
  return view.shown ?? (first ? { item: first.id, page: 1, present: false } : null);
}

/** Pages, or a photo or video: a link or a guest's deck (a card on the screen) has nothing to present. */
export const canPresent = (/** @type {Item} */ item, /** @type {PhoneView} */ view) =>
  !!pagesOf(item, view) || onStage(item);

/**
 * The command a tap makes, or null when it would change nothing. A new item starts at its first page and keeps
 * presenting if it can be presented.
 * @param {PhoneView} view
 * @param {Shown} at
 * @param {{item: string} | {step: number} | {present: true}} tap
 * @returns {Shown | null}
 */
export function command(view, at, tap) {
  if ("item" in tap) {
    const item = view.items.find((x) => x.id === tap.item);
    if (item?.kind !== "file") return null;
    const next = { item: item.id, page: 1, present: at.present && canPresent(item, view) };
    return item.id === at.item && at.page === 1 && next.present === at.present ? null : next;
  }
  const item = view.items.find((x) => x.id === at.item);
  if (!item) return null;
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
 * }} io adopt renders the page, so the remote repaints with it
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
    /** Sends what a tap asks for, if it changes anything. */
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
      // A stale seq answers with the current view, adopted like any push. Equal `v`: the state already held.
      if (res.ok && res.value.v > (io.view()?.v ?? -1)) return io.adopt(res.value);
      if (!res.ok) io.refused(res.error);
      io.paint();
    },
  };
}
