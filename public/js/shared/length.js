// One copy for the Worker's length route and the phone's Session Expiry sheet, which loads it only when opened.

/** The shortest length the phone may set (`POST /api/session/length`). */
export const MIN_LENGTH_MINUTES = 5;

/** A time this recently past is a slip for "now", so it means the shortest length, never tomorrow's. */
const JUST_PAST_MINUTES = 60;

/**
 * Whole minutes from `now` to the next `HH:MM` on this phone's clock: today, or tomorrow once it has passed by more
 * than an hour; a time within the last hour (the current minute included) is the minimum.
 * @param {string} value an `<input type="time">` value
 * @param {Date} [now]
 */
export function minutesUntil(value, now = new Date()) {
  const [h = 0, m = 0] = value.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  const ago = (now.getTime() - target.getTime()) / 60_000;
  if (ago >= 0 && ago < JUST_PAST_MINUTES) return MIN_LENGTH_MINUTES;
  if (ago >= 0) target.setDate(target.getDate() + 1);
  return Math.round((target.getTime() - now.getTime()) / 60_000);
}

/** A length the route takes: at least the minimum, at most the mode's cap. @param {number} minutes @param {number} max */
export const clampLength = (minutes, max) => Math.min(Math.max(minutes, MIN_LENGTH_MINUTES), max);
