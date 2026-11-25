// The Session Expiry sheet's time rules and words, loaded with the sheet (Set stays off until they are in); the sheet's
// parts that a preset needs are in shared/length.js.
import { MIN_LENGTH_SECONDS } from "../shared/length.js";
import { toast } from "./toast.js";

/**
 * Whole seconds from `now` to the next `HH:MM:00` on this phone's clock: today while it is still ahead, otherwise
 * tomorrow (a time just past is about a day away, never shortened to the minimum). In the hour a clock change
 * repeats, a time whose first instant has passed is still ahead at its second.
 * @param {string} value an `<input type="time">` value
 * @param {Date} [now]
 */
export function secondsUntil(value, now = new Date()) {
  const [h = 0, m = 0] = value.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    const again = new Date(target.getTime() + 3_600_000);
    if (again.getTime() > now.getTime() && again.getHours() === h && again.getMinutes() === m)
      target.setTime(again.getTime());
    else target.setDate(target.getDate() + 1);
  }
  return Math.floor((target.getTime() - now.getTime()) / 1000);
}

/**
 * Whether a typed time may be set: its next occurrence is at least the minimum away and within `roomSeconds`, what the
 * server leaves (it stops at approval plus the cap). Nothing is clamped, so a time just past (a day away) is refused.
 * @param {string} value @param {number} roomSeconds @param {Date} [now]
 */
export function canSet(value, roomSeconds, now = new Date()) {
  if (!value) return false;
  const seconds = secondsUntil(value, now);
  return seconds >= MIN_LENGTH_SECONDS && seconds <= roomSeconds;
}

/**
 * Set is usable only for a time at least a minute ahead and within the room the server leaves; says why when it is not.
 * @param {{set: {disabled: boolean}, hint: {hidden: boolean | "until-found", textContent: string}, at: {value: string}}} el
 * @param {number} room seconds the end may still move @param {string} latest the latest end, on the phone's clock
 * @returns {boolean} whether Set is usable
 */
export function refresh(el, room, latest) {
  const ok = canSet(el.at.value, room);
  el.set.disabled = !ok;
  el.hint.hidden = ok;
  if (!ok) {
    el.hint.textContent = !el.at.value
      ? "Pick a time"
      : secondsUntil(el.at.value) < MIN_LENGTH_SECONDS
        ? "Pick a time at least 1 minute ahead"
        : `Pick a time before ${latest}`;
  }
  return ok;
}

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
