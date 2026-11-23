// Pure parts of the demo screen's result (screen-demo.js). No DOM, so the unit tests run them in Node.

const PROTOCOL_PREFIX = "ms-powerpoint:ofv|u|";

/** The sample deck's slides, one AVIF and one WebP each (tools/render-slides.py). */
export const SLIDES = ["/img/demo-slide-1", "/img/demo-slide-2"];

/** The https link inside a pushed link (protocol or plain), when it is on this origin; null otherwise. */
export function openTarget(/** @type {string} */ link, /** @type {string} */ origin) {
  try {
    const url = new URL(link.startsWith(PROTOCOL_PREFIX) ? link.slice(PROTOCOL_PREFIX.length) : link);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

/** The slide after a step, held at either end. */
export const nextSlide = (/** @type {number} */ at, /** @type {number} */ step) =>
  Math.min(SLIDES.length - 1, Math.max(0, at + step));
