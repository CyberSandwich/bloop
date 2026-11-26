// The "Anywhere" sheen follows the pointer over the h1 (design.md section 8), loaded at the first pointerenter.
// Offsets are fractions of the sheen's tile, so no unit is converted twice.

// What site.css states: the tile is 5em, a band's center sits 66% along it, a sweep takes 2 s.
const TILE_EM = 5;
const BAND = 0.66;
const SWEEP_MS = 2000;
// Resuming ramps the sweep from rest to full speed; its distance is half of speed times time.
const EASE_MS = 300;
const EASE_TILES = EASE_MS / 2 / SWEEP_MS;

/**
 * The tile offset that puts a band's center under a pointer, kept over the word.
 * @param {number} x pointer x from the word's left edge, in px
 * @param {number} width the word's width, in px
 * @param {number} em the word's font size, in px
 */
export function offsetAt(x, width, em) {
  const t = Math.min(Math.max(x, 0), width) / em / TILE_EM - BAND;
  return t - Math.floor(t);
}

/** The sweep's time at a tile offset: a negative animation-delay of it starts the sweep there. */
export const timeAt = (/** @type {number} */ offset) => offset * SWEEP_MS;

// The band trails the pointer with this time constant: a slight lag reads as weight, not as a stuck highlight.
const TAU_MS = 120;

/**
 * One step of an exponential follow; the same at any frame rate, since it depends on elapsed time only.
 * @param {number} from the shown x
 * @param {number} to the pointer's x
 * @param {number} dt ms since the last step: a frame stamp can precede the event's own, and a stalled frame is capped
 */
export const easeTo = (from, to, dt) => from + (to - from) * (1 - Math.exp(-Math.min(Math.max(dt, 0), 64) / TAU_MS));

export function follow() {
  const h1 = document.querySelector(".hero h1");
  const el = h1?.querySelector(".sheen");
  if (!(h1 instanceof HTMLElement && el instanceof HTMLElement)) return;
  let on = false;
  let em = 1;
  let target = 0;
  // The band's place in tiles, unwrapped so an ease takes the shorter way round.
  let cur = 0;
  let last = 0;
  let frame = 0;
  /** @type {Animation | undefined} */
  let ramp;

  const measure = () => {
    em = parseFloat(getComputedStyle(el).fontSize);
  };
  // Any number of tiles is a valid position: the background repeats.
  const show = () => el.style.setProperty("--sheen-x", `${cur}`);
  // The box is read here, once a frame and only while the band moves, so a scroll or a reflow never leaves it stale.
  /** @param {number} now */
  const step = (now) => {
    const r = el.getBoundingClientRect();
    const d = offsetAt(target - r.left, r.width, em) - cur;
    const gap = d - Math.round(d);
    cur = easeTo(cur, cur + gap, now - last);
    last = now;
    // Under half a pixel it lands, and nothing runs until the pointer moves again.
    const landed = Math.abs(gap) * TILE_EM * em < 0.5;
    if (landed) cur += gap;
    show();
    frame = landed ? 0 : requestAnimationFrame(step);
  };

  h1.addEventListener("pointermove", (/** @type {PointerEvent} */ e) => {
    if (e.pointerType === "touch") return;
    target = e.clientX;
    if (!on) {
      // Focus in the hero keeps its pause (2.2.2).
      if (h1.closest(".hero")?.matches(":focus-within")) return;
      ramp?.cancel();
      on = true;
      measure();
      // The band eases from where the sweep has it to the pointer, so entry has no jump.
      cur = parseFloat(getComputedStyle(el).backgroundPosition) / em / TILE_EM;
      el.classList.add("is-following");
      show();
    }
    if (!frame) {
      last = performance.now();
      frame = requestAnimationFrame(step);
    }
  });

  h1.addEventListener("pointerleave", () => {
    if (!on) return;
    on = false;
    cancelAnimationFrame(frame);
    frame = 0;
    const to = cur + EASE_TILES;
    const ease = el.animate(
      { backgroundPosition: [`${cur * TILE_EM}em 0`, `${to * TILE_EM}em 0`] },
      // t squared: speed climbs linearly from rest to the sweep's own.
      { duration: EASE_MS, easing: "cubic-bezier(.33,0,.67,.33)", fill: "forwards" },
    );
    ramp = ease;
    ease.onfinish = () => {
      el.style.animationDelay = `${-timeAt(to - Math.floor(to))}ms`;
      el.classList.remove("is-following");
      ease.cancel();
    };
  });

  addEventListener("resize", () => {
    if (on) measure();
  });
}
