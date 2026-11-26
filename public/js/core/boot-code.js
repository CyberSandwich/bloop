// Imported first by /a so it runs before anything else on the page: it takes the pairing code out of
// the address bar (architecture.md section 4.1), so it never lingers in history or a screenshot.
/** @import {createStore} from "./store.js" */
import { codeFromSearch } from "./format.js";

export const bootCode = codeFromSearch(location.search);
if (location.search) history.replaceState(null, "", location.pathname);

/** The sessionStorage key of a code kept across sign-in (core/early.js), the other way a code reaches /a. */
export const KEPT = "bloop.resume";

/** @typedef {{code: string, key: string, at: number}} Kept a refused claim: its code, its Idempotency-Key, when */

/**
 * The kept claim, taken once: read and dropped, so a later visit to /a never replays it. Unused for 5 minutes, or not
 * ours, it is none. Here and not in core/early.js, so a resume never waits on (or loses its code to) a lazy load.
 * @param {ReturnType<typeof createStore>} store
 * @returns {Kept | null}
 */
export function takeClaim(store, now = Date.now()) {
  const raw = store.get(KEPT);
  store.remove(KEPT);
  try {
    const kept = JSON.parse(raw ?? "");
    return typeof kept?.code === "string" && typeof kept.key === "string" && now - kept.at < 300_000 ? kept : null;
  } catch {
    return null;
  }
}
