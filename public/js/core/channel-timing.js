// The socket's and the polling fallback's timings (docs/architecture.md section 7).
/** Reconnect delays after the 1st, 2nd, ... failure; the last repeats. */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000];
/** Failed reconnects before the polling fallback starts. */
export const POLL_AFTER_FAILURES = 3;
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

/**
 * Half to all of a step, so screens that lost their sockets together (a deploy) do not return in the same second.
 * @param {number} ms @param {() => number} [random] in [0, 1)
 */
export const jitter = (ms, random = Math.random) => (0.5 + random() / 2) * ms;

/**
 * @param {number} failures consecutive failures, 1 for the first
 * @param {() => number} [random] in [0, 1)
 */
export const reconnectDelay = (failures, random = Math.random) =>
  jitter(RECONNECT_DELAYS[Math.min(Math.max(failures, 1), RECONNECT_DELAYS.length) - 1] ?? 30_000, random);

/** @param {number} failures */
export const shouldPoll = (failures) => failures >= POLL_AFTER_FAILURES;
