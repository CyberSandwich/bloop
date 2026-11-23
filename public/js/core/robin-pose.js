// The robin's poses, their blending, the explorer's scroll bands and the drag and Turn mapping. Pure.
// Poses are whole-object transforms: the mesh has no per-pose geometry (design.md open item 23).
// tools/robin-poses.json repeats POSES for tools/render-stills.py; a unit test keeps them equal.

/** @typedef {{yaw: number, pitch: number, roll: number, lift: number, shift: number}} Pose */
/** @typedef {"perch" | "look" | "turn" | "carry" | "away"} PoseName */
/** @typedef {Partial<Record<PoseName, number>>} PoseWeights */

/** @type {Readonly<Record<PoseName, Readonly<Pose>>>} */
export const POSES = Object.freeze({
  perch: Object.freeze({ yaw: -0.7, pitch: 0.12, roll: 0, lift: 0, shift: 0 }),
  look: Object.freeze({ yaw: -1.3, pitch: 0.2, roll: 0, lift: 0, shift: 0 }),
  turn: Object.freeze({ yaw: -0.1, pitch: 0.1, roll: 0, lift: 0, shift: 0 }),
  carry: Object.freeze({ yaw: -0.45, pitch: -0.12, roll: 0, lift: 0.04, shift: 0 }),
  away: Object.freeze({ yaw: 1.1, pitch: 0.05, roll: -0.16, lift: 0.1, shift: -0.06 }),
});

/** The explorer's steps: Scan, Check, Present, End. */
export const STEPS = /** @type {const} */ (["look", "turn", "carry", "away"]);
export const REST_YAW = POSES.perch.yaw;
/** One press of Turn Left or Turn Right: 30 degrees. */
export const TURN_STEP = Math.PI / 6;
/** A drag across the whole control turns this far. */
export const DRAG_SPAN = Math.PI;
export const MAX_OFFSET = Math.PI;
const KEYS = /** @type {const} */ (["yaw", "pitch", "roll", "lift", "shift"]);

/** @param {string} name @returns {name is PoseName} */
export const isPoseName = (name) => Object.hasOwn(POSES, name);

/** @param {number} x @param {number} lo @param {number} hi */
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** @param {Pose} a @param {Pose} b @param {number} t @returns {Pose} */
export function lerpPose(a, b, t) {
  const k = clamp(t, 0, 1);
  return /** @type {Pose} */ (Object.fromEntries(KEYS.map((key) => [key, a[key] + (b[key] - a[key]) * k])));
}

/**
 * A named pose, or the normalized mix of weighted poses. Throws on an unknown name or no weight, so a
 * typo never silently shows the perch.
 * @param {PoseName | PoseWeights} spec
 * @returns {Pose}
 */
export function resolvePose(spec) {
  if (typeof spec === "string") {
    if (!isPoseName(spec)) throw new Error(`unknown pose ${spec}`);
    return { ...POSES[spec] };
  }
  /** @type {Pose} */
  const out = { yaw: 0, pitch: 0, roll: 0, lift: 0, shift: 0 };
  let total = 0;
  for (const [name, weight] of Object.entries(spec)) {
    if (!isPoseName(name)) throw new Error(`unknown pose ${name}`);
    const w = Math.max(0, weight ?? 0);
    total += w;
    for (const key of KEYS) out[key] += POSES[name][key] * w;
  }
  if (total === 0) throw new Error("pose weights sum to 0");
  for (const key of KEYS) out[key] /= total;
  return out;
}

/**
 * Pinned progress 0..1 to a step (4 equal bands) and a blend: from the previous step's pose (the perch
 * before the first) to the band's own over the first half of the band, then held, so a card swap at a
 * band edge never meets a moving robin.
 * @param {number} progress
 * @returns {{step: number, weights: PoseWeights}}
 */
export function scrollPose(progress) {
  const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const step = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
  const blend = clamp((p * STEPS.length - step) * 2, 0, 1);
  const from = step === 0 ? "perch" : (STEPS[step - 1] ?? "perch");
  const to = STEPS[step] ?? "away";
  if (blend === 1) return { step, weights: { [to]: 1 } };
  if (blend === 0) return { step, weights: { [from]: 1 } };
  return { step, weights: { [from]: 1 - blend, [to]: blend } };
}

/**
 * ViewTimeline cover progress (0: the scene's top enters at the viewport bottom; 1: its bottom leaves
 * at the top) to pinned progress (0: its top meets the viewport top; 1: its bottom meets the bottom).
 * @param {number} cover @param {number} subject scene height @param {number} viewport viewport height
 */
export function containProgress(cover, subject, viewport) {
  const span = subject - viewport;
  if (!(span > 0) || !Number.isFinite(cover)) return 0;
  return clamp((cover * (subject + viewport) - viewport) / span, 0, 1);
}

/** The last band sentinel at or above the viewport top (their tops in px, in order). @param {number[]} tops */
export function bandFromTops(tops) {
  let step = 0;
  tops.forEach((top, i) => {
    if (top <= 1) step = i;
  });
  return step;
}

/** Where a tapped chip scrolls to: inside its band, past the blend. @param {number} step */
export const stepProgress = (step) => (clamp(Math.round(step), 0, STEPS.length - 1) + 0.75) / STEPS.length;

/** Drag offset: a drag across the control's width turns by DRAG_SPAN. @param {number} from @param {number} dx @param {number} width */
export const dragOffset = (from, dx, width) =>
  clamp(from + (dx / Math.max(1, width)) * DRAG_SPAN, -MAX_OFFSET, MAX_OFFSET);

/**
 * Keys on the drag control: -1 left, +1 right, 0 back to the step's yaw (Home), null for the page.
 * @param {string} key
 * @returns {-1 | 0 | 1 | null}
 */
export function turnKey(key) {
  if (key === "ArrowLeft" || key === "ArrowDown") return -1;
  if (key === "ArrowRight" || key === "ArrowUp") return 1;
  return key === "Home" ? 0 : null;
}

/** @param {number} offset @param {-1 | 0 | 1} dir */
export const turnOffset = (offset, dir) => (dir === 0 ? 0 : clamp(offset + dir * TURN_STEP, -MAX_OFFSET, MAX_OFFSET));
