// What both sign-in pages need before the code step: the sentence row under a field, the slow rule, the failure
// lines and where a sign-in may land. The code step itself (code-entry.js) loads on demand. No DOM lookups: the parts
// come in, so the unit tests drive it with fakes.
import { AUTH } from "./copy.js";

/** The slow rule (docs/ux/states.md): a line at 4 s, a stop at 15 s. */
export const SLOW_MS = 4000;
export const STOP_MS = 15_000;
/** Where a sign-in may land (src/worker/page-registry.ts SIGNIN_NEXT); anything else is the library. */
export const NEXT_PATHS = ["/library", "/a", "/account", "/admin"];

/** @typedef {{now: () => number, later: (fn: () => void, ms: number) => unknown, cancel: (timer: unknown) => void}} Clock */
/**
 * The page's clock: monotonic, so a device clock set wrong or changed mid-step never moves a deadline.
 * @type {Clock}
 */
export const CLOCK = {
  now: () => performance.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (t) => clearTimeout(/** @type {any} */ (t)),
};

/** @typedef {{ok: true, value: any} | {ok: false, error: string, retryAfter?: number}} Reply */
/** @typedef {{textContent: string | null, hidden: boolean | "until-found", classList: {toggle(name: string, on?: boolean): unknown}}} Line */

/** `?next=` checked against the exact paths (`land` sends a non-admin's /admin to the library). */
export function nextFrom(/** @type {string} */ search) {
  const asked = new URLSearchParams(search).get("next") ?? "";
  return NEXT_PATHS.includes(asked) ? asked : "/library";
}

/**
 * The sentence row under a field: a status line (with a spinner while busy) and an alert line share one 24 px row.
 * @param {{hint: Line, hintText: Line, error: Line, errorText: Line}} parts
 */
export function createRow({ hint, hintText, error, errorText }) {
  const set = (/** @type {string} */ status, /** @type {string} */ alert, busy = false) => {
    hintText.textContent = status;
    hint.classList.toggle("is-busy", busy);
    hint.hidden = alert !== "";
    errorText.textContent = alert;
    error.classList.toggle("is-on", alert !== "");
  };
  return {
    status: (/** @type {string} */ text, busy = false) => set(text, "", busy),
    alert: (/** @type {string} */ text) => set("", text),
    clear: () => set("", ""),
  };
}
/** @typedef {ReturnType<typeof createRow>} Row */

/** @typedef {{pause?: () => void, resume?: () => void}} Hold */
/**
 * Runs a request under the slow rule: `slow` at 4 s, `stop` at 15 s. The request is never aborted, so an answer that
 * lands after the stop still counts (the caller decides whether to act on it). `hold` gets pause and resume: while a
 * person solves a challenge the clock is theirs, and resume starts the rule again.
 * @template T @param {Promise<T>} request @param {{slow: () => void, stop: () => void}} on @param {Clock} [clock]
 * @param {Hold} [hold]
 */
export function watch(request, on, clock = CLOCK, hold = {}) {
  /** @type {unknown[]} */
  let timers = [];
  let settled = false;
  const pause = () => {
    for (const t of timers) clock.cancel(t);
    timers = [];
  };
  hold.pause = pause;
  hold.resume = () => {
    pause();
    if (!settled) timers = [clock.later(on.slow, SLOW_MS), clock.later(on.stop, STOP_MS)];
  };
  hold.resume();
  return request.finally(() => {
    settled = true;
    pause();
  });
}

/**
 * What a failed request shows in the row: offline (and a filter's block page), a full bucket with its wait, and
 * anything else as bloop not responding (plan A section 6; never "something went wrong").
 * @param {{error: string, retryAfter?: number}} reply @param {Row} row
 */
export function showFailure(reply, row) {
  row.alert(
    reply.error === "offline" || reply.error === "network_blocked"
      ? AUTH.offline
      : reply.error === "rate_limited"
        ? AUTH.code.tooManyCodes(reply.retryAfter ?? 60)
        : AUTH.down,
  );
}

/**
 * The skip link focuses `focus`'s target without writing its #id into the address: a fragment change is a history
 * entry, and Back would then land on the same step instead of the one before.
 * @param {{querySelector(selector: string): {addEventListener(type: string, fn: (e: {preventDefault(): void}) => void): void} | null}} doc
 * @param {() => void} focus
 */
export function quietSkip(doc, focus) {
  doc.querySelector(".skip")?.addEventListener("click", (e) => {
    e.preventDefault();
    focus();
  });
}
