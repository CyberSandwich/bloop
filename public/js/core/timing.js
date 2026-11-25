// Client timings. The code values mirror the config defaults and only drive visuals and the rotation
// request; the server decides what is valid.
export const CODE_TTL_MS = 60_000;
export const CODE_GRACE_MS = 10_000;
/** The screen asks for the next code this long before the shown one hard-expires. */
export const ROTATE_AHEAD_MS = CODE_GRACE_MS;
export const ENDED_QR_RETURN_MS = 3000;
/** Session Ended stays this long when it says what to clean up, or on the demo (its waitlist link). */
export const ENDED_HOLD_MS = 10_000;
/** A tap or Enter this soon after Session Ended shows is the tail of the press that ended it, not a skip. */
export const ENDED_SKIP_GRACE_MS = 500;
export const ERROR_RECOVER_MS = 5000;
/**
 * Download starts a link it already started again for this long, and this many times in all, instead of minting one
 * against that item's LINK_MINTS_PER_ITEM. Both stay well inside the server's LINK_FETCH_WINDOW_SECONDS and LINK_MAX_FETCHES,
 * which a browser may spend more than once per start.
 */
export const DOWNLOAD_REUSE_MS = 60_000;
export const DOWNLOAD_STARTS_PER_LINK = 3;
/** An approved screen that has received no link by now asks for one. */
export const RELINK_WAIT_MS = 1500;
/** A request with no answer by now counts as offline. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Reconnect delays after the 1st, 2nd, ... failure; the last repeats. */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000];
/** Failed reconnects before the polling fallback starts. */
export const POLL_AFTER_FAILURES = 3;
export const POLL_MS = 3000;
/** A poll in `open`, where little changes by itself, and in a hidden tab. */
export const POLL_QUIET_MS = 15_000;
export const POLL_HIDDEN_MS = 30_000;
/** The longest a `Retry-After` is honored. */
export const RETRY_AFTER_MAX_MS = 120_000;
/** Frames sent within this long of the last one go together after it, the latest of each type. */
export const COALESCE_MS = 150;
/** Poll delays after the 1st, 2nd, ... failed poll; the last repeats. */
export const POLL_BACKOFF = [5000, 10_000, 30_000];
/** A socket with no first frame by now is abandoned and polling starts at once (a proxy that holds the upgrade). */
export const CONNECT_TIMEOUT_MS = 4000;
/** Once the socket is found blocked, it is tried again this often while polling carries the page. */
export const BLOCKED_PROBE_MS = 60_000;
export const PING_MS = 25_000;
/** A socket quiet for longer than PING_MS when the tab shows again is asked; no frame back in this long replaces it. */
export const PROBE_MS = 3000;
/** This many pings in a row with no frame back close a socket; a hidden tab is not judged. */
export const MISSED_PINGS = 2;
/** The Worker's window for calling a socket quiet (the client counts missed pings instead). */
export const SILENCE_MS = 70_000;
/** A second `service_down` answer this soon after the first says "bloop Isn't Responding". */
export const DOWN_CONFIRM_MS = 10_000;

/**
 * Half to all of the step, so screens that lost their sockets together (a deploy) do not return in the same second.
 * @param {number} failures consecutive failures, 1 for the first
 * @param {() => number} [random] in [0, 1)
 */
export const reconnectDelay = (failures, random = Math.random) =>
  (0.5 + random() / 2) * (RECONNECT_DELAYS[Math.min(Math.max(failures, 1), RECONNECT_DELAYS.length) - 1] ?? 30_000);

/** @param {number} failures */
export const shouldPoll = (failures) => failures >= POLL_AFTER_FAILURES;

/**
 * The wait before the next poll: fast while the room is being set up, slower in `open` and slowest when the tab is
 * hidden; a failure backs off from that, and a `Retry-After` is a floor.
 * @param {number} pollFailures consecutive failed polls, 0 when the last one worked
 * @param {string} [state] the last view's state
 * @param {boolean} [hidden]
 * @param {number} [retryAfter] seconds the server asked for
 */
export const pollDelay = (pollFailures, state = "", hidden = false, retryAfter = 0) => {
  const base = hidden ? POLL_HIDDEN_MS : state === "open" ? POLL_QUIET_MS : POLL_MS;
  const backoff = pollFailures <= 0 ? 0 : (POLL_BACKOFF[Math.min(pollFailures, POLL_BACKOFF.length) - 1] ?? 30_000);
  return Math.max(base, backoff, Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS));
};
