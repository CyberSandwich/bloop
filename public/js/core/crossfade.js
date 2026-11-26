// Another item over the last (design.md section 8): the stage and the phone's preview, loaded once either can change
// item. Not loaded, or under reduced motion, an item swaps at once.

/** Under reduced motion an item swaps at once. */
export const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Fades `into` in and `out` (already placed over it, in one box) away over 200 ms, opacity only; the last leaves at
 * the end unless a later change took it back (it is no longer inert). A picture is `display: contents`: its img fades.
 * @param {HTMLElement[]} into @param {HTMLElement[]} out
 */
export function crossfade(into, out) {
  const timing = {
    duration: 200,
    easing: getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim(),
  };
  for (const n of [...into, ...out]) {
    const gone = out.includes(n);
    const face = n.localName === "picture" ? (n.querySelector("img") ?? n) : n;
    n.inert = gone;
    // One grid cell on the stage; the preview places its last one itself.
    n.style.gridArea = "1/1";
    for (const a of face.getAnimations()) a.cancel();
    face.animate({ opacity: gone ? [1, 0] : [0, 1] }, timing).finished.then(
      () => gone && n.inert && n.remove(),
      () => {},
    );
  }
}

/**
 * The phone's preview: the last page stays until `pic` decodes; if the page shown then is another item's (its
 * `data-item`), `pic` cross-fades over it. The chip's `tally` changes with the page it counts.
 * @param {HTMLElement} box @param {HTMLElement} pic @param {HTMLElement} count @param {string} tally
 * @param {() => boolean} live false once a later page took its place
 * @returns {Promise<boolean>} whether `pic` landed
 */
export function swap(box, pic, count, tally, live) {
  return /** @type {HTMLImageElement} */ (pic.querySelector("img"))
    .decode()
    .catch(() => {})
    .then(() => {
      if (!live()) return false;
      const was = /** @type {HTMLElement | null} */ (box.querySelector("picture"));
      const last = was && was.dataset.item !== pic.dataset.item && !still() ? was : null;
      box.replaceChildren(pic, ...(last ? [last] : []), count);
      count.textContent = tally;
      if (last) {
        last.style.cssText = "position:absolute;inset:0";
        crossfade([pic], [last]);
      }
      return true;
    });
}
