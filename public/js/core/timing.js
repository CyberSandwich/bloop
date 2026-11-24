// Client timings. The code values mirror the config defaults and only drive visuals and the rotation
// request; the server decides what is valid.
export const CODE_TTL_MS = 60_000;
export const CODE_GRACE_MS = 10_000;
/** The screen asks for the next code this long before the shown one hard-expires. */
export const ROTATE_AHEAD_MS = CODE_GRACE_MS;
export const ENDED_QR_RETURN_MS = 3000;
/** Session Ended stays this long when it says what to clean up, or on the demo (its waitlist link). */
export const ENDED_HOLD_MS = 10_000;
export const ERROR_RECOVER_MS = 5000;
/** No /f/ fetch this long after the launch: Download It Instead appears (design.md, opening). */
export const LAUNCH_TIMEOUT_MS = 5000;
/**
 * Download starts a link it already started again for this long, and this many times in all, instead of minting one
 * against that item's LINK_MINTS_PER_ITEM. Both stay well inside the server's LINK_FETCH_WINDOW_SECONDS and LINK_MAX_FETCHES,
 * which a browser may spend more than once per start.
 */
export const DOWNLOAD_REUSE_MS = 60_000;
export const DOWNLOAD_STARTS_PER_LINK = 3;
/** An approved screen that has received no link by now asks for one. */
export const RELINK_WAIT_MS = 1500;
export const OFFLINE_HINT_MS = 5000;

/** Reconnect delays after the 1st, 2nd, ... failure; the last repeats. */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000];
/** Failed reconnects before the polling fallback starts. */
export const POLL_AFTER_FAILURES = 3;
export const POLL_MS = 3000;
/** Poll delays after the 1st, 2nd, ... failed poll; the last repeats. */
export const POLL_BACKOFF = [5000, 10_000, 30_000];
export const PING_MS = 25_000;
/** A socket that has said nothing for this long is dropped and reconnected. */
export const SILENCE_MS = 70_000;

/** @param {number} failures consecutive failures, 1 for the first */
export const reconnectDelay = (failures) =>
  RECONNECT_DELAYS[Math.min(Math.max(failures, 1), RECONNECT_DELAYS.length) - 1] ?? 30_000;

/** @param {number} failures */
export const shouldPoll = (failures) => failures >= POLL_AFTER_FAILURES;

/** @param {number} pollFailures consecutive failed polls, 0 when the last one worked */
export const pollDelay = (pollFailures) =>
  pollFailures <= 0 ? POLL_MS : (POLL_BACKOFF[Math.min(pollFailures, POLL_BACKOFF.length) - 1] ?? 30_000);
