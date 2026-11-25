// A presenter's clicker sends F5 (its play button) and Home and End: loaded as soon as the viewer shows its first item,
// so the first key is already intercepted (F5 would reload the page mid-talk). Rules: docs/design.md, the viewer.

/** Home and End: the first and the last page (`go` clamps the far one). */
const EDGES = /** @type {Record<string, number>} */ ({ Home: 0, End: Number.MAX_SAFE_INTEGER });

/**
 * @param {{
 *   live: () => boolean,
 *   typing: (target: EventTarget | null) => boolean,
 *   presenting: () => boolean,
 *   can: () => boolean,
 *   pages: () => boolean,
 *   ask: (on: boolean) => void,
 *   jump: (to: number) => void,
 * }} h `live`: an item is shown and the viewer is not parked
 */
export function clickerKeys(h) {
  document.addEventListener("keydown", (e) => {
    const edge = EDGES[e.key];
    if ((e.key !== "F5" && edge === undefined) || e.altKey || e.ctrlKey || e.metaKey || !h.live()) return;
    if (e.key === "F5") {
      e.preventDefault();
      if (!e.repeat && !h.typing(e.target) && !h.presenting() && h.can()) h.ask(true);
    } else if (h.pages() && !h.typing(e.target)) {
      e.preventDefault();
      h.jump(edge ?? 0);
    }
  });
}
