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

/** A hidden tab's socket quiet this long is dropped (its timers are throttled, so pings are not counted); the Worker's window too. */
export const SILENCE_MS = 70_000;
