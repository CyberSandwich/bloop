// The demo screen's viewer (DEMO-01, docs/design.md section 7). Nothing launches: the page fetches the launched link
// itself, so the session reaches `open`. An image is its view link in an <img> kept for the session: the CSP allows
// no blob: URL, and a second mint would spend the budget. A link is a card opened in a new tab, never a frame.
/** @import {Item, OpenMode, ScreenView} from "../../src/shared/protocol.ts" */
/** @import {Minted} from "./types.js" */
import { openTarget, pagesOf, stepPage, thumbOf } from "./core/demo.js";
import { hostOf, itemIcon, itemLine, itemName } from "./core/format.js";
import { rowFace, tile } from "./core/rows.js";
import { byId, el, icon, setText, show } from "./core/ui.js";

/** The fetch PowerPoint would make: a HEAD, on this origin only. @returns {boolean} */
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
/** Up to this many pages show as dots; more show "3 of 9". */
const MAX_DOTS = 6;
const SWIPE_PX = 40;

/**
 * @param {{relink: (item: number) => Promise<Minted>, onChange: () => void}} deps
 */
export function createViewer(deps) {
  const side = byId("side");
  const list = byId("items");
  const handle = byId("handle");
  const frame = byId("frame");
  const pager = byId("pager");
  const prev = /** @type {HTMLButtonElement} */ (byId("prev"));
  const next = /** @type {HTMLButtonElement} */ (byId("next"));
  const dots = byId("dots");

  /** @type {ScreenView | null} */
  let view = null;
  /** @type {string | null} */
  let built = null;
  let at = 0;
  let page = 0;
  /** @type {string | null} */
  let framed = null;
  /** @type {Map<number, HTMLImageElement>} */
  const images = new Map();
  /** @type {Set<number>} */
  const asked = new Set();
  /** @type {Set<number>} minting failed: the card instead, and no retry loop */
  const refused = new Set();

  const source = el("source", { type: "image/avif" });
  const slide = el("img", { width: "1920", height: "1200", decoding: "async" });
  const picture = el("picture", {}, [source, slide]);

  const items = () => view?.items ?? [];
  const pages = () => {
    const item = items()[at];
    return item && view ? pagesOf(item, view) : null;
  };

  function select(/** @type {number} */ i) {
    at = i;
    page = 0;
    if (side.matches(":popover-open")) side.hidePopover();
    deps.onChange();
  }

  function go(/** @type {number} */ by) {
    const p = pages();
    if (!p) return;
    page = stepPage(page, by, p.length);
    paint();
  }

  function buildList() {
    if (!view) return;
    const v = view;
    let files = 0;
    list.replaceChildren(
      ...v.items.map((item, i) => {
        const button = el("button", { type: "button", class: "item" }, rowFace(item, thumbOf(item, v)));
        button.addEventListener("click", () => select(i));
        // Files A to Z, then the links under one inset rule.
        const split = item.kind === "link" && files > 0 && files === i;
        if (item.kind === "file") files += 1;
        return el("li", split ? { class: "split" } : {}, [button]);
      }),
    );
  }

  /** @param {Item} item */
  function card(item) {
    const host = item.kind === "link" ? hostOf(item.url) : "";
    return el("div", { class: "item-card" }, [
      tile(itemIcon(item)),
      el("p", { class: "item-title" }, [host || itemName(item)]),
      el("p", { class: "small" }, [item.kind === "link" ? item.title : itemLine(item)]),
      // https only (LINK-01): the server allows nothing else, and the page checks again before it makes a link.
      ...(item.kind === "link" && item.url.startsWith("https://")
        ? [
            el("a", { class: "btn primary", href: item.url, target: "_blank", rel: "noopener noreferrer" }, [
              `Open ${host}`,
            ]),
          ]
        : []),
    ]);
  }

  function image(/** @type {number} */ i) {
    const img = images.get(i);
    if (img || asked.has(i) || refused.has(i)) return img ?? null;
    // While approved, the launch item's link is the launcher's to recover; a second ask would spend a mint.
    if (view?.state === "approved" && view.items.findIndex((x) => x.kind === "file") === i) return null;
    asked.add(i);
    deps.relink(i).then(() => {
      asked.delete(i);
      if (view && !images.has(i)) refused.add(i);
      paint();
    });
    return null;
  }

  function paint() {
    const v = view;
    const item = items()[at];
    if (!v || !item) return;
    const many = v.items.length > 1;
    show(side, many);
    show(handle, many);
    for (const [i, li] of [...list.children].entries()) {
      const button = li.firstElementChild;
      if (i === at) button?.setAttribute("aria-current", "true");
      else button?.removeAttribute("aria-current");
    }
    handle.replaceChildren(
      ...rowFace(item, thumbOf(item, v)),
      el("span", { class: "small" }, [`${v.items.length} items`]),
      icon(["m18 15-6-6-6 6"], 20),
    );

    const p = pages();
    // A demo account's file with no pages is the photo; a guest's own file has only a card.
    const photo = item.kind === "file" && !p && v.kind === "owner";
    const img = photo ? image(at) : null;
    const loading = photo && !img && !refused.has(at);
    const want = p ? `p${at}:${page}` : img ? `i${at}` : loading ? `w${at}` : `c${at}`;
    if (want !== framed) {
      framed = want;
      frame.classList.toggle("is-card", !p && !img && !loading);
      if (p) {
        const base = p[page] ?? "";
        source.setAttribute("srcset", `${base}.avif`);
        slide.setAttribute("src", `${base}.webp`);
        slide.setAttribute(
          "alt",
          `${item.kind === "file" && item.type === "pdf" ? "Page" : "Slide"} ${page + 1} of ${p.length}`,
        );
        frame.replaceChildren(picture);
      } else if (img) {
        img.alt = itemName(item);
        frame.replaceChildren(img);
      } else frame.replaceChildren(...(loading ? [] : [card(item)]));
    }
    show(frame, true);

    show(pager, !!p && p.length > 1);
    if (p) {
      prev.disabled = page === 0;
      next.disabled = page === p.length - 1;
      dots.classList.toggle("count", p.length > MAX_DOTS);
      if (p.length > MAX_DOTS) setText(dots, `${page + 1} of ${p.length}`);
      else dots.replaceChildren(...p.map((_, i) => el("i", i === page ? { class: "on" } : {})));
    }
  }

  function clear() {
    for (const img of images.values()) img.removeAttribute("src");
    images.clear();
    asked.clear();
    refused.clear();
    list.replaceChildren();
    frame.replaceChildren();
    built = framed = null;
    at = page = 0;
    show(side, false);
    show(handle, false);
    show(frame, false);
    show(pager, false);
    if (document.fullscreenElement === frame) document.exitFullscreen().catch(() => {});
  }

  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  document.addEventListener("keydown", (e) => {
    const step = KEYS[e.key];
    if (!view || !step || e.altKey || e.ctrlKey || e.metaKey || !pages()) return;
    e.preventDefault();
    go(step);
  });
  let downX = 0;
  frame.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
  });
  frame.addEventListener("pointerup", (e) => {
    const dx = e.clientX - downX;
    if (Math.abs(dx) >= SWIPE_PX) go(dx < 0 ? 1 : -1);
  });

  return {
    /** The viewer for a demo view from approved to open; null takes it down and lets go of every image. */
    render(/** @type {ScreenView | null} */ next) {
      if (!next) {
        if (view) clear();
        view = null;
        return;
      }
      view = next;
      const key = JSON.stringify(next.items);
      if (key !== built) {
        built = key;
        framed = null;
        at = Math.min(at, next.items.length - 1);
        buildList();
      }
      paint();
    },

    /** A link the launcher would open in a window. @param {string} url @param {number} item @param {OpenMode} mode */
    take(url, item, mode) {
      const target = openTarget(url, location.origin);
      if (!target) return false;
      if (mode !== "view") return fetchOpen(target);
      const img = el("img", { decoding: "async", referrerpolicy: "no-referrer", alt: "" });
      img.addEventListener("load", () => deps.onChange());
      img.src = target;
      images.set(item, img);
      asked.delete(item);
      framed = null;
      if (view) paint();
      return true;
    },

    /** The item on the stage, or null. */
    item: () => (view ? (items()[at] ?? null) : null),
    at: () => at,

    /** Full screen for pages and a loaded image; a link or a file card has nothing to present. */
    presentable() {
      const img = images.get(at);
      return document.fullscreenEnabled && (!!pages() || !!img?.naturalWidth);
    },
    present() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else frame.requestFullscreen().catch(() => {});
    },
  };
}
