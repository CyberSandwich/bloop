// The Session Expiry sheet's rarer words: why Set is off, and the toast for an end the server cut short. Loaded by the
// sheet when one is needed.
import { toast } from "./toast.js";

/**
 * Why Set is off.
 * @param {string} value the typed time @param {boolean} soon it is under a minute ahead
 * @param {string} latest the latest end, on the phone's clock
 */
export const hintText = (value, soon, latest) =>
  !value ? "Pick a time" : soon ? "Pick a time at least 1 minute ahead" : `Pick a time before ${latest}`;

/**
 * Whether the server stopped the end more than a minute short of what was asked (approval plus the cap): the phone says
 * so rather than let a long ask look accepted. @param {number} endsAt @param {number} now @param {number} seconds
 */
export const cutShort = (endsAt, now, seconds) => endsAt < now + seconds * 1000 - 60_000;

/** @param {{endsAt: number | null, now: number}} next the answer @param {number} seconds what was asked @param {string} at the end's time */
export function capped(next, seconds, at) {
  if (next.endsAt != null && cutShort(next.endsAt, next.now, seconds)) {
    toast({ title: `Capped at ${at}`, body: "That is the longest this session can run." });
  }
}
