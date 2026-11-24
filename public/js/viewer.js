// The demo viewer (DEMO-01, design.md section 7). Nothing launches: the page fetches the launched link itself.
// An image's <img> is kept for the session: the CSP has no blob:, and a second mint spends the budget.
/** @import {Item, OpenMode, ScreenView} from "../../src/shared/protocol.ts" */
/** @import {Minted} from "./types.js" */
import { halves, openTarget, pageMode, pagesOf, placeControls, stepPage, thumbOf } from "./core/demo.js";
import { hostOf, itemIcon, itemLine, itemName } from "./core/format.js";
import { ICONS } from "./core/icons.js";
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

/** https only (LINK-01): the server allows nothing else, and the page checks again before it makes a link. */
const linkTo = (
  /** @type {string} */ url,
  /** @type {Record<string, string>} */ attrs,
  /** @type {(Node | string)[]} */ kids,
) =>
  url.startsWith("https://")
    ? el("a", { ...attrs, href: url, target: "_blank", rel: "noopener noreferrer" }, kids)
    : el("span", attrs, kids);

/**
 * @param {{relink: (item: number) => Promise<Minted>, onChange: () => void}} deps
 */
export function createViewer(deps) {
  const side = byId("side");
  const list = byId("items");
  const handle = byId("handle");
  const view = byId("view");
  const frame = byId("frame");
  const prev = /** @type {HTMLButtonElement} */ (byId("prev"));
  const next = /** @type {HTMLButtonElement} */ (byId("next"));
  const dots = byId("dots");
  const note = byId("parked");
  const pill = byId("controls");
  const pane = byId("pane");
  const stop = byId("b-stop");
  const body = document.body;
  const presenting = () => body.classList.contains("is-presenting");
  // The pill sits 16 under the item, or, where that would shrink the item, as a column beside it (bottom-aligned,
  // on its left under a side list); a scrolling document gets it at the stage's foot. The tap zones cover the slide's
  // own box. Offsets, not client rects: the swap animation scales the img.
  const fit = () => {
    const img = frame.querySelector("img");
    const scrolls = frame.classList.contains("is-scroll");
    const item = scrolls ? null : (img ?? frame.firstElementChild);
    const css = getComputedStyle(view);
    const gap = parseFloat(css.getPropertyValue("--pill")) + 16;
    const reserve = parseFloat(css.getPropertyValue("--stack")) + 16;
    // The file's own ratio (rounded box sizes could flip a near tie); the stand-in is the photo's 3 : 2.
    const ratio =
      item === img && img ? (img.classList.contains("stand-in") ? 1.5 : img.naturalWidth / img.naturalHeight) : 0;
    // The column's height is read with the column on; the side list's box says whether it fits under it.
    pane.classList.toggle("is-stacked", !!ratio && !presenting());
    const stack = pill.offsetHeight;
    const listed = !side.hidden && matchMedia("(min-width: 760px)").matches;
    const listFits = listed && side.getBoundingClientRect().bottom + 16 + stack <= view.getBoundingClientRect().bottom;
    const place =
      ratio && !presenting()
        ? placeControls(ratio, view.offsetWidth, view.offsetHeight, { reserve, gap, stack, listFits })
        : "below";
    pane.classList.toggle("is-stacked", place !== "below");
    pane.classList.toggle("is-stack-right", place === "right");
    if (place === "right" && item instanceof HTMLElement) {
      pill.style.top = `${view.offsetTop + item.offsetTop + item.offsetHeight - stack}px`;
      pill.style.left = `${view.offsetLeft + item.offsetLeft + item.offsetWidth + 16}px`;
    } else if (place === "list") {
      pill.style.top = `${view.offsetTop + view.offsetHeight - stack}px`;
      pill.style.left = `${side.getBoundingClientRect().left - pane.getBoundingClientRect().left}px`;
    } else {
      const top =
        item instanceof HTMLElement ? item.offsetTop + item.offsetHeight + 16 : view.offsetHeight - pill.offsetHeight;
      pill.style.top = `${view.offsetTop + top}px`;
      pill.style.left = "";
    }
    if (!img) return;
    const box = { left: img.offsetLeft, top: img.offsetTop, width: img.offsetWidth, height: img.offsetHeight };
    for (const [i, part] of halves(box).entries()) {
      const zone = i ? next : prev;
      zone.style.left = `${part.left}px`;
      zone.style.top = `${part.top}px`;
      zone.style.width = `${part.width}px`;
      zone.style.height = `${part.height}px`;
    }
  };
  const sized = new ResizeObserver(fit);
  // The pane's entry slides it 12 px, which the list's box does not share.
  pane.addEventListener("animationend", fit);
  // The file's own ratio decides the placement, and it is known only once the image has loaded (load does not bubble).
  frame.addEventListener("load", fit, true);

  /** @type {ScreenView | null} */
  let shown = null;
  /** @type {string | null} */
  let built = null;
  let at = 0;
  /** Held for a transient state: nothing repaints it until render. */
  let parked = false;
  let page = 0;
  /** @type {string | null} */
  let framed = null;
  // Per-item state is keyed by idOf, never by list position: a guest file sorting in ahead shifts every position.
  /** @type {Map<string, HTMLImageElement>} */
  const images = new Map();
  /** @type {Map<number, HTMLImageElement>} images taken before the first render, by list position */
  const early = new Map();
  /** @type {Set<string>} */
  const asked = new Set();
  /** @type {Set<string>} minting failed: the card instead, and no retry loop */
  const refused = new Set();
  /** @type {Set<string>} */
  const tall = new Set();
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) page = Number(e.target.getAttribute("data-page"));
      paintDots();
    },
    { root: frame, threshold: 0.5 },
  );

  const items = () => shown?.items ?? [];
  /** An item's identity in a list. The protocol carries no item id, so it is kind, name or title, and the count of
   * same-named items before it: two guest files can share a name, and the list's order keeps them apart.
   * @param {readonly {kind: string, name?: string, title?: string}[]} list @param {number} i */
  const idOf = (list, i) => {
    const it = list[i];
    if (!it) return null;
    const label = (/** @type {typeof it} */ x) => `${x.kind}:${x.name ?? x.title}`;
    return `${label(it)}#${list.slice(0, i).filter((x) => label(x) === label(it)).length}`;
  };
  const keyOf = (/** @type {number} */ i) => idOf(items(), i) ?? "";
  const pages = () => {
    const item = items()[at];
    return item && shown ? pagesOf(item, shown) : null;
  };

  function picture(/** @type {string} */ base, /** @type {number} */ n, /** @type {number} */ of) {
    const it = items()[at];
    const pdf = it?.kind === "file" && it.type === "pdf";
    const img = el("img", {
      src: `${base}.webp`,
      width: "1920",
      height: "1200",
      decoding: "async",
      alt: `${pdf ? "Page" : "Slide"} ${n + 1} of ${of}`,
      "data-page": String(n),
    });
    const key = keyOf(at);
    img.addEventListener("load", () => {
      if (n === 0 && !tall.has(key) && pageMode(img.naturalWidth, img.naturalHeight) === "scroll") {
        tall.add(key);
        framed = null;
        paint();
      }
    });
    return el("picture", {}, [el("source", { type: "image/avif", srcset: `${base}.avif` }), img]);
  }

  function select(/** @type {number} */ i) {
    at = i;
    page = 0;
    if (side.matches(":popover-open")) side.hidePopover();
    deps.onChange();
  }

  function go(/** @type {number} */ by) {
    const p = pages();
    if (!p || parked) return;
    page = stepPage(page, by, p.length);
    if (tall.has(keyOf(at))) frame.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
    else paint();
  }

  function buildList() {
    if (!shown) return;
    const v = shown;
    let files = 0;
    list.replaceChildren(
      ...v.items.map((item, i) => {
        const face = rowFace(item, thumbOf(item, v));
        const row =
          item.kind === "link"
            ? linkTo(item.url, { class: "item" }, [
                ...face,
                icon(ICONS["arrow-up-right"], true),
                el("span", { class: "sr" }, ["New Tab"]),
              ])
            : el("button", { type: "button", class: "item" }, face);
        if (item.kind === "file") row.addEventListener("click", () => select(i));
        const split = item.kind === "link" && files > 0 && files === i;
        if (item.kind === "file") files += 1;
        const p = pagesOf(item, v);
        if (p) new Image().src = `${p[0]}.avif`;
        return el("li", split ? { class: "split" } : {}, [row]);
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
      ...(item.kind === "link"
        ? [linkTo(item.url, { class: "btn primary" }, [`Open ${host}`, el("span", { class: "sr" }, [" in a New Tab"])])]
        : []),
    ]);
  }

  function image(/** @type {number} */ i) {
    const key = keyOf(i);
    const img = images.get(key);
    if (img || asked.has(key) || refused.has(key)) return img ?? null;
    // While approved, the launch item's link is the launcher's to recover; a second ask would spend a mint.
    if (shown?.state === "approved" && shown.items.findIndex((x) => x.kind === "file") === i) return null;
    asked.add(key);
    deps.relink(i).then(() => {
      asked.delete(key);
      if (shown && !images.has(key)) refused.add(key);
      paint();
    });
    return null;
  }

  function paintDots() {
    const p = pages();
    if (parked) return;
    show(dots, !!p && p.length > 1);
    if (!p) return;
    prev.disabled = page === 0;
    next.disabled = page === p.length - 1;
    setText(dots, `${page + 1} / ${p.length}`);
  }

  function paint() {
    const v = shown;
    const item = items()[at];
    if (!v || !item || parked) return;
    const many = v.items.length > 1;
    show(side, many);
    show(handle, many);
    for (const [i, li] of [...list.children].entries()) {
      const row = li.firstElementChild;
      if (i === at) row?.setAttribute("aria-current", "true");
      else row?.removeAttribute("aria-current");
    }
    handle.replaceChildren(
      ...rowFace(item, thumbOf(item, v)),
      el("span", { class: "small" }, [`${v.items.length} items`]),
      icon(ICONS["chevron-up"], true),
    );

    const p = pages();
    const scroll = !!p && tall.has(keyOf(at));
    // A demo account's file with no pages is the photo; a guest's own file has only a card.
    const photo = item.kind === "file" && !p && v.kind === "owner";
    const img = photo ? image(at) : null;
    const loading = photo && !img && !refused.has(keyOf(at));
    const want = p ? `p${at}:${scroll ? "all" : page}` : img ? `i${at}` : loading ? `w${at}` : `c${at}`;
    if (want !== framed) {
      framed = want;
      seen.disconnect();
      view.classList.toggle("is-card", !p && !img && !loading);
      frame.classList.toggle("is-scroll", scroll);
      if (scroll && p) {
        frame.replaceChildren(...p.map((base, n) => picture(base, n, p.length)));
        for (const one of frame.querySelectorAll("img")) seen.observe(one);
      } else if (p) frame.replaceChildren(picture(p[page] ?? "", page, p.length));
      else if (img) {
        img.alt = itemName(item);
        frame.replaceChildren(img);
      } else {
        // While the photo loads, its row thumbnail holds the stage.
        const thumb = thumbOf(item, v);
        frame.replaceChildren(
          loading ? (thumb ? el("img", { class: "stand-in", src: thumb, alt: "" }) : "") : card(item),
        );
      }
      sized.disconnect();
      const target = frame.querySelector("img") ?? frame.firstElementChild;
      // The pill (its buttons appear after the item) and the list (it grows with a guest's file) set the place too.
      for (const box of target ? [target, view, pill, side] : [view, pill, side]) sized.observe(box);
    }
    show(view, true);
    show(frame, true);
    show(note, false);
    show(prev, !!p && !scroll && p.length > 1);
    show(next, !!p && !scroll && p.length > 1);
    paintDots();
  }

  function hide() {
    for (const part of [side, handle, view, dots]) show(part, false);
    if (side.matches(":popover-open")) side.hidePopover();
  }

  function clear() {
    for (const img of images.values()) img.removeAttribute("src");
    images.clear();
    early.clear();
    asked.clear();
    refused.clear();
    seen.disconnect();
    list.replaceChildren();
    frame.replaceChildren();
    built = framed = null;
    at = page = 0;
    parked = false;
    hide();
    // Hidden while presenting is a black room screen; only a real end leaves it.
    present(false);
  }

  /** Pages and a loaded image; a link or a file card has nothing to present. */
  const presentable = () => !!pages() || !!images.get(keyOf(at))?.naturalWidth;
  let sleep = 0;
  /** @type {HTMLElement | null} */
  let opener = null;
  /** The one way in and out of the presenting layout (the item on black, the chrome gone): the page's own, which
   * browser full screen then joins where it exists, so both look the same. */
  function present(/** @type {boolean} */ on) {
    if (on === presenting()) return;
    if (on) opener = /** @type {HTMLElement | null} */ (document.activeElement);
    body.classList.toggle("is-presenting", on);
    show(stop, on);
    // Focus follows the layout, so it never drops to the body when the button it was on is hidden.
    if (on) stop.focus?.({ preventScroll: true });
    else opener?.focus?.({ preventScroll: true });
    if (on) {
      band = Math.max(BAND, stop.offsetHeight + 32);
      // A Stop that lands before the browser grants it must still leave full screen.
      if (document.fullscreenEnabled)
        view
          .requestFullscreen()
          .then(() => {
            if (!presenting()) return document.exitFullscreen();
          })
          .catch(() => {});
    } else {
      clearTimeout(sleep);
      clearTimeout(still);
      clearTimeout(cursor);
      view.classList.remove("is-awake", "is-idle");
      aim(Number.POSITIVE_INFINITY);
      if (document.fullscreenElement === view) document.exitFullscreen().catch(() => {});
      if (parked) hide();
    }
  }
  // Stop Presenting is hidden until the pointer nears the window's top: its opacity follows the distance, from 0
  // at BAND + RAMP down to 1 within the band, and it takes a click only from half. Touch has no pointer to follow, so
  // a tap on the slide shows it for 3 s. Reduced motion has no ramp.
  const BAND = 64;
  const RAMP = 96;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let band = BAND;
  let frameAsked = 0;
  let still = 0;
  let cursor = 0;
  /** @param {number} y the pointer's distance from the window's top; Infinity when it is away */
  function aim(y) {
    const o = reduced.matches ? Number(y <= band) : Math.min(1, Math.max(0, (band + RAMP - y) / RAMP));
    view.style.setProperty("--stop-o", String(o));
    view.classList.toggle("is-reach", o >= 0.5);
  }
  function follow(/** @type {PointerEvent} */ e) {
    if (!presenting() || e.pointerType === "touch") return;
    const y = e.clientY;
    cancelAnimationFrame(frameAsked);
    frameAsked = requestAnimationFrame(() => aim(y));
    view.classList.remove("is-idle");
    clearTimeout(still);
    clearTimeout(cursor);
    // Resting outside the band, the pill goes; the cursor goes a second later.
    still = setTimeout(() => y > band && aim(Number.POSITIVE_INFINITY), 1000);
    cursor = setTimeout(() => view.classList.add("is-idle"), 2000);
  }
  /** Stop Presenting shows for 3 s after a tap. */
  function awake() {
    view.classList.add("is-awake");
    clearTimeout(sleep);
    sleep = setTimeout(() => view.classList.remove("is-awake"), 3000);
  }

  // Leaving full screen ends presenting; held, the hold then goes on the page: the stage hides.
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) return;
    present(false);
    if (parked) hide();
  });
  stop.addEventListener("click", () => present(false));
  let swipe = 0;
  let swiped = false;
  view.addEventListener("pointerdown", (e) => {
    swipe = e.clientX;
    swiped = false;
  });
  view.addEventListener("pointermove", follow);
  view.addEventListener("pointerleave", () => presenting() && aim(Number.POSITIVE_INFINITY));
  view.addEventListener("pointerup", (e) => {
    swiped = presenting() && Math.abs(e.clientX - swipe) > 50;
    if (swiped) go(e.clientX < swipe ? 1 : -1);
    else if (
      presenting() &&
      e.pointerType === "touch" &&
      !(/** @type {Element} */ (e.target).closest?.("#prev, #next, #b-stop"))
    )
      awake();
  });
  // A swipe that ends on the zone it began on would page twice.
  view.addEventListener(
    "click",
    (e) => {
      if (swiped) {
        e.stopPropagation();
        e.preventDefault();
      }
      swiped = false;
    },
    true,
  );
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") present(false);
    const step = KEYS[e.key];
    const t = e.target;
    if (!shown || parked || !step || e.altKey || e.ctrlKey || e.metaKey || !pages()) return;
    if (t instanceof Element && (side.contains(t) || t.matches("input, textarea"))) return;
    e.preventDefault();
    go(step);
  });

  return {
    /** The viewer for a demo view from approved to open; null takes it down and lets go of every image. */
    render(/** @type {ScreenView | null} */ nextView) {
      if (!nextView) {
        if (shown) clear();
        shown = null;
        return;
      }
      const id = shown ? idOf(items(), at) : null;
      shown = nextView;
      parked = false;
      for (const [i, img] of early) images.set(keyOf(i), img);
      early.clear();
      const key = JSON.stringify(nextView.items);
      if (key !== built) {
        built = key;
        framed = null;
        // A file joining the list ahead of the selection must not change what is on screen.
        const moved = nextView.items.findIndex((_, i) => idOf(nextView.items, i) === id);
        at = moved >= 0 ? moved : Math.max(0, Math.min(at, nextView.items.length - 1));
        buildList();
      }
      if (presenting() && !presentable()) present(false);
      paint();
    },

    /** A transient state holds the stage; presenting, it stays there with the status line, so render resumes in
     * place. @param {string} line */
    park(line) {
      parked = true;
      if (!presenting()) return hide();
      for (const part of [frame, prev, next]) show(part, false);
      setText(note, line);
      show(note, true);
    },

    /** A link the launcher would open in a window. @param {string} url @param {number} item @param {OpenMode} mode */
    take(url, item, mode) {
      const target = openTarget(url, location.origin);
      if (!target) return false;
      if (mode !== "view") return fetchOpen(target);
      const img = el("img", { decoding: "async", referrerpolicy: "no-referrer", alt: "" });
      img.addEventListener("load", () => deps.onChange());
      img.src = target;
      // The launch can land before the first render: with no list there is no identity yet, so it waits by position.
      if (!shown) early.set(item, img);
      else {
        images.set(keyOf(item), img);
        asked.delete(keyOf(item));
      }
      framed = null;
      if (shown) paint();
      return true;
    },

    item: () => (shown ? (items()[at] ?? null) : null),
    at: () => at,

    presentable,
    present,
  };
}
