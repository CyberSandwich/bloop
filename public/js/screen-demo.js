// The demo screen's result (/s?mode=demo, DEMO-01): nothing launches. The page fetches the open link itself, as
// PowerPoint would, so the session reaches `open`, and shows the file in the page: the sample deck as slide images
// (tools/render-slides.py), a guest's own file as a card. Built from the screen's view, so a reload shows it again.
/** @import {ScreenView} from "../../src/shared/protocol.ts" */
import { nextSlide, openTarget, SLIDES } from "./core/demo.js";
import { fileIcon, sizeLabel } from "./core/format.js";
import { el, icon, setText, show } from "./core/ui.js";

/**
 * The fetch PowerPoint would make. A HEAD moves the bytes nowhere; a refusal changes nothing the page shows.
 * @returns {boolean} false for a link that is not on this origin, which is never fetched
 */
export function fetchOpen(/** @type {string} */ link) {
  const url = openTarget(link, location.origin);
  if (!url) return false;
  fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).catch(() => {});
  return true;
}

const KEYS = /** @type {Record<string, number>} */ ({
  ArrowRight: 1,
  ArrowDown: 1,
  PageDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  PageUp: -1,
});

/** @param {HTMLElement} root the empty, hidden result container in s.html */
export function createDemoResult(root) {
  let at = 0;
  /** @type {string | null} what is built: "deck", or the guest file's name */
  let built = null;

  const source = el("source", { type: "image/avif" });
  const img = el("img", { width: "1920", height: "1200", decoding: "async" });
  const count = el("span", { class: "small" });
  const full = el("button", { type: "button", class: "btn text" }, ["Full Screen"]);
  const hit = el("button", { type: "button", class: "slide-hit", "aria-label": "Next slide" }, [
    el("picture", {}, [source, img]),
  ]);
  const figure = el("figure", { class: "slides" }, [hit, el("figcaption", {}, [count, full])]);

  function go(/** @type {number} */ to) {
    at = to;
    const base = SLIDES[at] ?? "";
    source.setAttribute("srcset", `${base}.avif`);
    img.setAttribute("src", `${base}.webp`);
    const label = `Slide ${at + 1} of ${SLIDES.length}`;
    img.setAttribute("alt", label);
    setText(count, label);
  }

  hit.addEventListener("click", () => go(nextSlide(at, 1)));
  full.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else figure.requestFullscreen().catch(() => {});
  });
  document.addEventListener("keydown", (e) => {
    const step = KEYS[e.key];
    if (built !== "deck" || !step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    go(nextSlide(at, step));
  });

  function card(/** @type {ScreenView} */ view) {
    const name = view.fileName ?? "";
    return el("div", { class: "file-card" }, [
      icon(fileIcon(name), 32),
      el("div", {}, [
        el("p", { class: "file-name" }, [name]),
        el("p", { class: "small" }, [view.fileSize === null ? "" : sizeLabel(view.fileSize)]),
      ]),
    ]);
  }

  return {
    /** The result for a demo view from approved to open; null hides it and lets go of the deck. */
    render(/** @type {ScreenView | null} */ view) {
      const want = !view ? null : view.kind === "guest" ? `guest:${view.fileName}` : "deck";
      if (want !== built) {
        built = want;
        if (want === "deck") {
          go(0);
          show(full, document.fullscreenEnabled);
          root.replaceChildren(figure);
        } else root.replaceChildren(...(view && want ? [card(view)] : []));
        if (!want && document.fullscreenElement === figure) document.exitFullscreen().catch(() => {});
      }
      show(root, want !== null);
    },
  };
}
