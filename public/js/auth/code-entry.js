// The code step, one for every page that asks for an emailed code (sign-in and invite here; reauth and email change
// later): digits only, shown 3 and 3, sent on the 6th digit or a paste, with the page's own attempt count, expiry
// line and resend countdown (plan A section 7.1). Loaded when a page reaches the step. No DOM lookups: the parts come
// in, so the unit tests drive it with fakes.
import { AUTH } from "./copy.js";
import { CLOCK, showFailure, watch } from "./row.js";

/** @import {Clock, Reply, Row} from "./row.js" */

export const CODE_DIGITS = 6;
/** The server spends one attempt per verify and refuses after 5 (auth/codes.ts); the page counts the same. */
export const MAX_TRIES = 5;
export const RESEND_MS = 30_000;

// The DOM slices it touches, typed by shape so the unit tests' fakes (and their DOM-less typecheck) fit.
/** @typedef {{addEventListener(type: string, fn: (e: any) => void): void}} Target */
/**
 * @typedef {Target & {value: string, disabled: boolean, focus(): void, select(): void,
 *   setAttribute(name: string, value: string): void, removeAttribute(name: string): void}} Field
 */

/** Every digit in `value`, uncut: more than 6 is not a code. */
export const digitsOf = (/** @type {string} */ value) => value.replace(/\D/g, "");
export const grouped = (/** @type {string} */ digits) =>
  digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;

/**
 * The line a refused code shows. The server answers only `code_invalid` (ADR 0014), so the page's deadline and count
 * choose: expired once the deadline has passed, too many from the 5th failure, else didn't match.
 * @param {number} tries @param {number | null} deadline @param {number} now
 */
export function refusal(tries, deadline, now) {
  if (deadline !== null && now >= deadline) return AUTH.code.expired;
  if (tries >= MAX_TRIES) return AUTH.code.tooMany;
  return AUTH.code.wrong;
}

/**
 * A code's deadline on `clock`, from the time left the 202 states (`expiresIn`). The absolute `expiresAt` is never
 * read: it is the server's clock, and a device clock set wrong would end the code early or late.
 * @param {unknown} answer @param {Clock} [clock]
 */
export function deadlineOf(answer, clock = CLOCK) {
  const left = /** @type {{expiresIn?: unknown} | null} */ (answer)?.expiresIn;
  return typeof left === "number" && Number.isFinite(left) ? clock.now() + left : null;
}

/**
 * After a verify, before leaving: the session cookie must have stuck, so `GET /api/me` decides (docs/ux/states.md,
 * cookies blocked). Only a definite signed-out answer stays (false); a failed read goes on and lets `next` show its
 * own state. `next` meets the member's role here, the first point the page knows it.
 * @param {() => Promise<Reply>} me @param {string} next @param {Row} row @param {(path: string) => void} go
 */
export async function land(me, next, row, go) {
  const reply = await me();
  if (reply.ok && reply.value?.signedIn !== true) {
    row.alert(AUTH.code.cookies);
    return false;
  }
  go(next === "/admin" && !(reply.ok && reply.value.admin === true) ? "/library" : next);
  return true;
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
 * @property {() => Promise<Reply>} resend sends a new code; an ok answer carries `expiresIn`
 * @property {(value: any) => Promise<boolean>} done the code verified; false when the page stays (cookies blocked)
 * @property {(reply: {error: string}) => boolean} [refused] a page-specific refusal; true when it handled it
 */

/**
 * Binds the code field. `start(answer)` opens a fresh code from the send's answer (after the first send and each
 * resend); `stop()` cancels its timers when the page leaves the step.
 * @param {CodeParts} parts @param {CodeHooks} hooks @param {Clock} [clock]
 */
export function createCodeEntry({ input, row, resend, doc }, hooks, clock = CLOCK) {
  let tries = 0;
  /** @type {number | null} */
  let deadline = null;
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

  function settle() {
    busy = false;
    input.disabled = false;
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
    // Past the local cap, no request. The deadline never blocks one: the server's clock decides expiry.
    if (tries >= MAX_TRIES) {
      refuse(AUTH.code.tooMany);
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
          settle();
          refuse(AUTH.slow.tooLong);
        },
      },
      clock,
    );
    // A success after the stop still signs in; a late failure changes nothing on a page that already moved on.
    if (reply.ok) {
      busy = true;
      if (!(await hooks.done(reply.value))) {
        settle();
        input.focus();
      }
      return;
    }
    if (stopped) return;
    settle();
    if (reply.error === "code_invalid") {
      tries++;
      refuse(refusal(tries, deadline, clock.now()));
    } else if (!hooks.refused?.(reply)) {
      showFailure(reply, row);
      input.focus();
    }
  }

  function take(/** @type {string} */ raw) {
    const digits = digitsOf(raw);
    // More digits than a code holds is something else pasted or filled in: cleared, never cut to a guess.
    if (digits.length > CODE_DIGITS) {
      input.value = "";
      row.status(AUTH.code.hint);
      return;
    }
    const shown = grouped(digits);
    if (input.value !== shown) input.value = shown;
    if (digits.length === CODE_DIGITS) submit(digits);
  }

  input.addEventListener("input", () => take(input.value));
  // A pasted "481 207" or "481-207" is the whole code: read it from the clipboard, so maxlength never cuts it.
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (digitsOf(text).length < CODE_DIGITS) return;
    e.preventDefault();
    take(text);
  });
  resend.addEventListener("click", async () => {
    if (resend.disabled || !active) return;
    resend.disabled = true;
    let stopped = false;
    const reply = await watch(
      hooks.resend(),
      {
        slow: () => row.status(AUTH.slow.still, true),
        stop: () => {
          stopped = true;
          row.alert(AUTH.slow.tooLong);
          countdown(0);
        },
      },
      clock,
    );
    // A code sent after the stop is still on its way: the step opens for it.
    if (reply.ok) {
      open(reply.value);
      input.focus();
      return;
    }
    if (stopped) return;
    if (!hooks.refused?.(reply)) showFailure(reply, row);
    countdown(reply.error === "rate_limited" ? (reply.retryAfter ?? 60) * 1000 : 0);
  });
  // Back from the Mail app: the field is where the code goes.
  doc.addEventListener("visibilitychange", () => {
    if (!doc.hidden && active && !busy && input.value === "") input.focus();
  });

  /** @param {unknown} answer the send's 202 body */
  function open(answer) {
    clock.cancel(expiry);
    tries = 0;
    deadline = deadlineOf(answer, clock);
    active = true;
    input.value = "";
    settle();
    input.removeAttribute("aria-invalid");
    row.status(AUTH.code.hint);
    countdown(RESEND_MS);
    const at = deadline;
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
