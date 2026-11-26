// The match pick's state (core/match.js draws it): one tap, one POST, and the answer decides the next state. Pure:
// every effect is injected, so it runs under test with no DOM.
/** @import {ErrorCode, MatchResponse, PhoneView} from "../../../src/shared/protocol.ts" */
/** @import {Toast} from "./toast.js" */

/** From here a line under the choices says the approve is still on its way; no stop, since it may have landed. */
export const SLOW_MS = 4000;
/** a.html's legend holds the same words before this loads (pinned in client-match.test.ts). */
export const LEGEND = "Tap the Screen's Number";
export const SENDING = "Approving...";
export const SLOW = "Still approving. Keep this page open.";
/** Not lazy.js's refused(): that toast says "try again", and here the retry is a tap on the number. @type {Toast} */
export const OFFLINE = {
  title: "You're Offline",
  body: "Check your connection, then tap the number again.",
  error: true,
};

/**
 * @typedef {{ok: true, value: MatchResponse} | {ok: false, error: ErrorCode, code?: unknown}} Answer
 * @typedef {{picked: (view: PhoneView) => void, wrong: () => void, fail: (code: ErrorCode) => void}} PickIo what
 *   phone.js hands over
 * @typedef {{canceling: boolean, pid: string | null}} PickCtx
 * @typedef {{
 *   post: (path: string, body: unknown, auth: string | null, key: string) => Promise<Answer>,
 *   paint: (tapped: string | null, slow: boolean) => void,
 *   toast: (t: Toast) => void,
 *   buzz: () => void,
 *   later: (fn: () => void, ms: number) => unknown,
 *   stop: (timer: unknown) => void,
 * }} PickParts the page's side
 */

/**
 * One pick in flight at a time. A number tapped is one intent with one Idempotency-Key, sent again when it is tapped
 * again (after a lost answer); another number is another intent.
 * @param {PickCtx} c
 * @param {PickIo & PickParts} io
 * @returns {(choice: string) => Promise<void>}
 */
export function createPick(c, io) {
  let busy = false;
  /** @type {Record<string, string>} */
  const keys = {};
  return async (choice) => {
    if (busy) return;
    busy = true;
    io.paint(choice, false);
    const timer = io.later(() => io.paint(choice, true), SLOW_MS);
    // A wrong pick drops the pairing, and its push can beat this answer: `canceling` holds it back (as Cancel does).
    // So a lost answer to a wrong pick reads as offline, and the retap as expired (design.md, Match pick).
    c.canceling = true;
    keys[choice] ??= crypto.randomUUID();
    const res = await io.post("/api/match", { choice }, c.pid, keys[choice]);
    c.canceling = false;
    io.stop(timer);
    busy = false;
    if (res.ok) {
      // The tick lands on the confirmed answer: the phone cannot know the right number before it.
      io.buzz();
      return io.picked(res.value.view);
    }
    io.paint(null, false);
    if (res.error === "offline") return io.toast(OFFLINE);
    // An AppError, so the page's own table maps it to bad_request; api.js keeps the code for this.
    if (res.code === "match_wrong") return io.wrong();
    io.fail(res.error);
  };
}
