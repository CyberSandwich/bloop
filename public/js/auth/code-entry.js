// The code step, one for every page that asks for an emailed code (sign-in and invite here; reauth and email change
// later): digits only, shown 3 and 3, sent on the 6th digit or a paste, with the page's own attempt count, expiry
// clock and resend countdown (plan A section 7.1). No DOM lookups and no ui.js: the parts come in, so the unit tests
// drive it with fakes.
import { AUTH } from "./copy.js";

export const CODE_DIGITS = 6;
/** The server spends one attempt per verify and refuses after 5 (auth/codes.ts); the page counts the same. */
export const MAX_TRIES = 5;
export const RESEND_MS = 30_000;
/** The slow rule (docs/ux/states.md): a line at 4 s, a stop at 15 s. */
export const SLOW_MS = 4000;
export const STOP_MS = 15_000;
/** Where a sign-in may land (ADR 0015 with plan A 13.4); anything else is the library. */
export const NEXT_PATHS = ["/library", "/a", "/account", "/admin"];

/** @typedef {{now: () => number, later: (fn: () => void, ms: number) => unknown, cancel: (timer: unknown) => void}} Clock */
/** @type {Clock} */
const CLOCK = {
  now: () => Date.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (t) => clearTimeout(/** @type {any} */ (t)),
};

/** @typedef {{ok: true, value: any} | {ok: false, error: string, retryAfter?: number}} Reply */
// The DOM slices it touches, typed by shape so the unit tests' fakes (and their DOM-less typecheck) fit.
/** @typedef {{addEventListener(type: string, fn: (e: any) => void): void}} Target */
/** @typedef {{textContent: string | null, hidden: boolean | "until-found", classList: {toggle(name: string, on?: boolean): unknown}}} Line */
/**
 * @typedef {Target & {value: string, disabled: boolean, focus(): void, select(): void,
 *   setAttribute(name: string, value: string): void, removeAttribute(name: string): void}} Field
 */

export const digitsOf = (/** @type {string} */ value) => value.replace(/\D/g, "").slice(0, CODE_DIGITS);
export const grouped = (/** @type {string} */ digits) =>
  digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;

/**
 * The line a refused code shows. The server answers only `code_invalid` (ADR 0014), so the page's clock and count
 * choose: expired once `expiresAt` has passed, too many from the 5th failure, else didn't match.
 * @param {number} tries @param {number | null} expiresAt @param {number} now
 */
export function refusal(tries, expiresAt, now) {
  if (expiresAt !== null && now >= expiresAt) return AUTH.code.expired;
  if (tries >= MAX_TRIES) return AUTH.code.tooMany;
  return AUTH.code.wrong;
}

/** `?next=` checked against the exact paths (`land` sends a non-admin's /admin to the library). */
export function nextFrom(/** @type {string} */ search) {
  const asked = new URLSearchParams(search).get("next") ?? "";
  return NEXT_PATHS.includes(asked) ? asked : "/library";
}

/** An answer's expiry, epoch ms; anything but a number is none (no local clock, the server still decides). */
export const expiryOf = (/** @type {unknown} */ at) => (typeof at === "number" && Number.isFinite(at) ? at : null);

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

/**
 * Runs a request under the slow rule: `slow` at 4 s, `stop` at 15 s. The request is never aborted, so an answer that
 * lands after the stop still counts (the caller decides whether to act on it).
 * @template T @param {Promise<T>} request @param {{slow: () => void, stop: () => void}} on @param {Clock} [clock]
 */
export function watch(request, on, clock = CLOCK) {
  const timers = [clock.later(on.slow, SLOW_MS), clock.later(on.stop, STOP_MS)];
  return request.finally(() => {
    for (const t of timers) clock.cancel(t);
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
 * After a verify, before leaving: the session cookie must have stuck, so `GET /api/me` decides (docs/ux/states.md,
 * cookies blocked). Only a definite signed-out answer stays; a failed read goes on and lets `next` show its own state.
 * `next` meets the member's role here, the first point the page knows it.
 * @param {() => Promise<Reply>} me @param {string} next @param {Row} row @param {(path: string) => void} go
 */
export async function land(me, next, row, go) {
  const reply = await me();
  if (reply.ok && reply.value?.signedIn !== true) {
    row.alert(AUTH.code.cookies);
    return;
  }
  go(next === "/admin" && !(reply.ok && reply.value.admin === true) ? "/library" : next);
}

/**
 * @typedef {object} CodeParts
 * @property {Field} input
 * @property {Row} row
 * @property {Target & {disabled: boolean, textContent: string | null}} resend
 * @property {Target & {hidden: boolean}} doc for visibilitychange
 */
/**
 * @typedef {object} CodeHooks
 * @property {(code: string) => Promise<Reply>} verify
 * @property {() => Promise<Reply>} resend sends a new code; an ok answer may carry `expiresAt`
 * @property {(value: any) => void} done the code verified
 * @property {(reply: {error: string}) => boolean} [refused] a page-specific refusal; true when it handled it
 */

/**
 * Binds the code field. `start(expiresAt)` opens a fresh code (after the first send and each resend); `stop()`
 * cancels its timers when the page leaves the step.
 * @param {CodeParts} parts @param {CodeHooks} hooks @param {Clock} [clock]
 */
export function createCodeEntry({ input, row, resend, doc }, hooks, clock = CLOCK) {
  let tries = 0;
  /** @type {number | null} */
  let expiresAt = null;
  let busy = false;
  let active = false;
  /** @type {unknown} */
  let expiry = null;
  /** @type {unknown} */
  let tick = null;

  function refuse(/** @type {string} */ line) {
    row.alert(line);
    input.setAttribute("aria-invalid", "true");
    input.focus();
    // The digits stay selected, so typing replaces them.
    input.select();
  }

  /** The resend button counts down `ms`, then reads Send a New Code. */
  function countdown(/** @type {number} */ ms) {
    clock.cancel(tick);
    const until = clock.now() + ms;
    const step = () => {
      const left = until - clock.now();
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? AUTH.code.resendIn(left) : AUTH.code.resend;
      // Wake on the next whole second, so the label never skips or lingers.
      tick = left > 0 ? clock.later(step, left % 1000 || 1000) : null;
    };
    step();
  }

  async function submit(/** @type {string} */ code) {
    if (busy || !active) return;
    // Past the local cap or clock, no request: the server would refuse it anyway.
    if (tries >= MAX_TRIES || (expiresAt !== null && clock.now() >= expiresAt)) {
      refuse(refusal(tries, expiresAt, clock.now()));
      return;
    }
    busy = true;
    let stopped = false;
    input.disabled = true;
    input.removeAttribute("aria-invalid");
    row.status(AUTH.code.checking, true);
    const reply = await watch(
      hooks.verify(code),
      {
        slow: () => row.status(AUTH.slow.still, true),
        stop: () => {
          stopped = true;
          busy = false;
          input.disabled = false;
          refuse(AUTH.slow.tooLong);
        },
      },
      clock,
    );
    // A success after the stop still signs in; a late failure changes nothing on a page that already moved on.
    if (reply.ok) {
      busy = true;
      hooks.done(reply.value);
      return;
    }
    if (stopped) return;
    busy = false;
    input.disabled = false;
    if (reply.error === "code_invalid") {
      tries++;
      refuse(refusal(tries, expiresAt, clock.now()));
    } else if (!hooks.refused?.(reply)) {
      showFailure(reply, row);
      input.focus();
    }
  }

  function take(/** @type {string} */ raw) {
    const digits = digitsOf(raw);
    const shown = grouped(digits);
    if (input.value !== shown) input.value = shown;
    if (digits.length === CODE_DIGITS) submit(digits);
  }

  input.addEventListener("input", () => take(input.value));
  // A pasted "481 207" or "481-207" is the whole code: read it from the clipboard, so maxlength never cuts it.
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (digitsOf(text).length !== CODE_DIGITS) return;
    e.preventDefault();
    take(text);
  });
  resend.addEventListener("click", async () => {
    if (resend.disabled || !active) return;
    resend.disabled = true;
    const reply = await hooks.resend();
    if (reply.ok) {
      open(expiryOf(reply.value?.expiresAt));
      input.focus();
      return;
    }
    if (!hooks.refused?.(reply)) showFailure(reply, row);
    countdown(reply.error === "rate_limited" ? (reply.retryAfter ?? 60) * 1000 : 0);
  });
  // Back from the Mail app: the field is where the code goes.
  doc.addEventListener("visibilitychange", () => {
    if (!doc.hidden && active && !busy && input.value === "") input.focus();
  });

  /** @param {number | null} at */
  function open(at) {
    clock.cancel(expiry);
    tries = 0;
    expiresAt = at;
    busy = false;
    active = true;
    input.value = "";
    input.disabled = false;
    input.removeAttribute("aria-invalid");
    row.status(AUTH.code.hint);
    countdown(RESEND_MS);
    expiry = at === null ? null : clock.later(() => !busy && refuse(AUTH.code.expired), Math.max(0, at - clock.now()));
  }

  return {
    start: open,
    stop() {
      active = false;
      clock.cancel(expiry);
      clock.cancel(tick);
    },
  };
}
