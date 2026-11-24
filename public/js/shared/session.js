// One copy for the Worker and the pages.
/** @import {SessionState} from "../../../src/shared/protocol.ts" */

/** @type {readonly SessionState[]} */
export const IN_SESSION = ["approved", "opening", "open"];

/** A claim not yet approved. @type {readonly SessionState[]} */
export const LIVE_CLAIM = ["claimed", "choosing"];

// The pairing is over: its pid opens nothing.
export const PAIRING_OVER = /** @type {readonly SessionState[]} */ (["ended", "waiting", "closed"]);

/**
 * Files by name, then links by title: every list, and every item index.
 * @template {{kind: "file", name: string} | {kind: "link", title: string}} T
 * @param {readonly T[]} items
 * @returns {T[]}
 */
export function orderItems(items) {
  const label = (/** @type {T} */ i) => (i.kind === "file" ? i.name : i.title);
  const rank = (/** @type {T} */ i) => (i.kind === "file" ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b), "en"));
}
