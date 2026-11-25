// The polling fallback, loaded when the socket cannot carry the page (a rare path, so it is not in every page's bundle),
// and the "bloop isn't responding" rule a boot shares. Rules: docs/architecture.md section 7.
import { POLL_BACKOFF } from "./channel-timing.js";

/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */

/** A poll while the room is being set up. */
export const POLL_MS = 3000;
/** A poll in `open`, where little changes by itself, and in a hidden tab. */
export const POLL_QUIET_MS = 15_000;
export const POLL_HIDDEN_MS = 30_000;
/** The longest a `Retry-After` is honored. */
export const RETRY_AFTER_MAX_MS = 120_000;

/**
 * The wait before the next poll: fast while the room is being set up, slower in `open` and slowest when the tab is
 * hidden; a failure backs off from that, and a `Retry-After` is a floor.
 * @param {number} failures consecutive failed polls, 0 when the last one worked
 * @param {string} [state] the last view's state
 * @param {boolean} [hidden]
 * @param {number} [retryAfter] seconds the server asked for
 */
export const pollDelay = (failures, state = "", hidden = false, retryAfter = 0) => {
  const base = hidden ? POLL_HIDDEN_MS : state === "open" ? POLL_QUIET_MS : POLL_MS;
  const backoff = failures <= 0 ? 0 : (POLL_BACKOFF[Math.min(failures, POLL_BACKOFF.length) - 1] ?? 30_000);
  return Math.max(base, backoff, Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS));
};

/** A server-side failure: the 5xx answers, which a page reads as one rule (poll and boot alike). @param {string} code */
export const isDown = (code) => code === "service_down" || code === "internal";

/**
 * Whether this is the second server failure in a row: one 5xx is not yet "bloop isn't responding". Any other answer
 * (ok, offline, blocked, a refusal) resets the count.
 * @returns {(down: boolean) => boolean}
 */
export function downGate() {
  let run = 0;
  return (down) => {
    run = down ? run + 1 : 0;
    return run >= 2;
  };
}

/** The room screen's boot shares the rule. */
export const bootGate = downGate();

/**
 * One polling loop. `start` is idempotent; a poll answered after `stop` or a restart ends there.
 * @param {{
 *   api: {get: (path: string, auth?: string | null) => Promise<any>},
 *   path: string,
 *   auth: string,
 *   hidden: () => boolean,
 *   state: () => string,
 *   active: () => boolean,
 *   fatal: (code: ErrorCode) => boolean,
 *   onView: (view: any) => void,
 *   onLink: (link: "ok" | "offline" | "down" | "blocked") => void,
 * }} h
 */
export function createPoller(h) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let gen = 0;
  let running = false;
  let failures = 0;
  const gate = downGate();

  async function poll() {
    timer = null;
    if (!running || !h.active()) return;
    const mine = gen;
    const res = await h.api.get(h.path, h.auth);
    if (mine !== gen || !h.active()) return;
    let retryAfter = 0;
    if (res.ok) {
      failures = 0;
      gate(false);
      h.onLink("ok");
      h.onView(res.value);
    } else if (h.fatal(res.error)) return;
    else {
      failures += 1;
      retryAfter = res.retryAfter ?? 0;
      const sure = gate(isDown(res.error));
      if (res.error === "offline") h.onLink("offline");
      else if (res.error === "network_blocked") h.onLink("blocked");
      else if (sure) h.onLink("down");
    }
    timer = setTimeout(poll, pollDelay(failures, h.state(), h.hidden(), retryAfter));
  }

  return {
    start() {
      if (running) return;
      running = true;
      gen += 1;
      timer = setTimeout(poll, 0);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      running = false;
      gen += 1;
      failures = 0;
    },
    /** The tab is visible again: poll now rather than wait out a slow delay. */
    soon() {
      if (!timer) return;
      clearTimeout(timer);
      timer = setTimeout(poll, 0);
    },
  };
}
