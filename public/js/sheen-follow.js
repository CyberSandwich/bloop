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

export function follow() {
  const h1 = document.querySelector(".hero h1");
  const el = h1?.querySelector(".sheen");
  if (!(h1 instanceof HTMLElement && el instanceof HTMLElement)) return;
  let on = false;
  let left = 0;
  let width = 0;
  let em = 1;
  let x = 0;
  let offset = 0;
  let frame = 0;
  /** @type {Animation | null} */
  let ramp = null;

  const measure = () => {
    const r = el.getBoundingClientRect();
    left = r.left;
    width = r.width;
    em = parseFloat(getComputedStyle(el).fontSize);
  };
  const place = () => {
    frame = 0;
    offset = offsetAt(x - left, width, em);
    el.style.setProperty("--sheen-x", `${offset}`);
  };

  h1.addEventListener("pointermove", (/** @type {PointerEvent} */ e) => {
    if (e.pointerType === "touch") return;
    x = e.clientX;
    if (on) {
      frame ||= requestAnimationFrame(place);
      return;
    }
    // Focus in the hero keeps its pause (2.2.2).
    if (h1.closest(".hero")?.matches(":focus-within")) return;
    ramp?.cancel();
    ramp = null;
    on = true;
    measure();
    el.classList.add("is-following");
    place();
  });

  h1.addEventListener("pointerleave", () => {
    if (!on) return;
    on = false;
    if (frame) {
      cancelAnimationFrame(frame);
      place();
    }
    const to = offset + EASE_TILES;
    const ease = el.animate(
      { backgroundPosition: [`${offset * TILE_EM}em 0`, `${to * TILE_EM}em 0`] },
      // t squared: speed climbs linearly from rest to the sweep's own.
      { duration: EASE_MS, easing: "cubic-bezier(.33, 0, .67, .33)", fill: "forwards" },
    );
    ramp = ease;
    ease.onfinish = () => {
      el.style.animationDelay = `${-timeAt(to - Math.floor(to))}ms`;
      el.classList.remove("is-following");
      ease.cancel();
      ramp = null;
    };
  });

  addEventListener("resize", () => {
    if (on) measure();
  });
}
