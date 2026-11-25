// One copy for the Worker's length route and the phone's Session Expiry sheet, which loads it only when opened.

/** The shortest length the phone may set (`POST /api/session/length`). */
export const MIN_LENGTH_SECONDS = 60;

/** Hides presets above the cap, and the pane when none is left. @param {any} pane @param {number} max */
export function fitPresets(pane, max) {
  if (!pane) return;
  const chips = [...pane.querySelectorAll("[data-minutes]")];
  for (const c of chips) c.hidden = Number(c.dataset.minutes) > max;
  pane.hidden = chips.every((c) => c.hidden);
}

/** A preset's length the route takes: at least the minimum, at most the mode's cap. @param {number} seconds @param {number} maxSeconds */
export const clampLength = (seconds, maxSeconds) => Math.min(Math.max(seconds, MIN_LENGTH_SECONDS), maxSeconds);
