// One copy for the Worker's length route and the phone's Session Expiry sheet, which loads it only when opened.

/** The shortest length the phone may set (`POST /api/session/length`). */
export const MIN_LENGTH_SECONDS = 60;

/**
 * Whole seconds from `now` to the next `HH:MM:00` on this phone's clock: today while it is still ahead, otherwise
 * tomorrow (a time just past is about a day away, never shortened to the minimum).
 * @param {string} value an `<input type="time">` value
 * @param {Date} [now]
 */
export function secondsUntil(value, now = new Date()) {
  const [h = 0, m = 0] = value.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return Math.floor((target.getTime() - now.getTime()) / 1000);
}

/**
 * Whether a typed time may be set: its next occurrence is at least the minimum away and within the cap. Nothing is
 * clamped, so a time just past (a day away) is refused rather than shortened.
 * @param {string} value @param {number} maxMinutes @param {Date} [now]
 */
export function canSet(value, maxMinutes, now = new Date()) {
  if (!value) return false;
  const seconds = secondsUntil(value, now);
  return seconds >= MIN_LENGTH_SECONDS && seconds <= maxMinutes * 60;
}

/** Hides presets above the cap, and the pane when none is left. @param {any} pane @param {number} max */
export function fitPresets(pane, max) {
  if (!pane) return;
  const chips = [...pane.querySelectorAll("[data-minutes]")];
  for (const c of chips) c.hidden = Number(c.dataset.minutes) > max;
  pane.hidden = chips.every((c) => c.hidden);
}

/** A preset's length the route takes: at least the minimum, at most the mode's cap. @param {number} seconds @param {number} maxSeconds */
export const clampLength = (seconds, maxSeconds) => Math.min(Math.max(seconds, MIN_LENGTH_SECONDS), maxSeconds);
