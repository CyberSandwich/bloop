// The demo viewer (DEMO-01, design.md section 7): the page fetches the launched link itself.
// A photo or a video is kept for the session: a second mint spends the budget.
/** @import {Item, OpenMode, ScreenView} from "../../src/shared/protocol.ts" */
/** @import {Minted} from "./types.js" */
import { CANT_PLAY } from "./core/copy.js";
import { halves, isVideoLink, openTarget, pageMode, pagesOf, placeControls, stepPage, thumbOf } from "./core/demo.js";
import { hostOf, itemIcon, itemLine, itemName } from "./core/format.js";
import { ICONS } from "./core/icons.js";
import { loader, readAll, setProgress } from "./core/loader.js";
import { rowFace, tile } from "./core/rows.js";
import { onStage } from "./core/states.js";
import { byId, el, icon, setText, show } from "./core/ui.js";

/** @typedef {{node?: HTMLCanvasElement | HTMLVideoElement, video?: boolean, ratio?: number | null, ready: boolean, failed: boolean, fraction: number | null, stop: () => void}} Shot */

/**
 * A photo's view link, read by script to count its bytes, drawn on a canvas: the CSP has no blob: for an <img>.
 * @param {string} url
 * @param {(shot: Shot) => void} onProgress
 * @param {(shot: Shot) => void} onDone loaded or failed; never after stop
 * @returns {Shot}
 */
function shoot(url, onProgress, onDone) {
  const abort = new AbortController();
  const canvas = el("canvas", { role: "img" });
  /** @type {Shot} */
  const shot = {
    node: canvas,
    ready: false,
    failed: false,
    fraction: null,
    // A zero-size canvas frees its pixels.
    stop: () => {
      abort.abort();
      canvas.width = 0;
    },
  };
  fetch(url, { signal: abort.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" })
    .then((res) => {
      if (!res.ok) throw Error(res.statusText);
      return readAll(res, (f) => {
        shot.fraction = f;
        onProgress(shot);
      });
    })
    .then((blob) => createImageBitmap(blob, { imageOrientation: "from-image" }))
    .then((bitmap) => {
      if (abort.signal.aborted) return bitmap.close();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      shot.ratio = bitmap.width / bitmap.height;
      bitmap.close();
      shot.ready = true;
    })
    .catch(() => {
      shot.failed = true;
    })
    .then(() => abort.signal.aborted || onDone(shot));
  return shot;
}

/** A video's view link: lazy viewer-video.js fills in the shot. @param {string} url @param {(shot: Shot) => void} onChange */
function film(url, onChange) {
  let live = true;
  /** @type {Shot} */
  const shot = {
    video: true,
    // Most recordings are 16 : 9.
    ratio: 16 / 9,
    ready: false,
    failed: false,
    fraction: null,
    stop: () => {
      live = false;
    },
  };
  import("./viewer-video.js").then(
    (m) => live && m.roll(shot, url, onChange),
    () => {
      if (!live) return;
      shot.failed = true;
      onChange(shot);
    },
  );
  return shot;
}

/** A drawn stage: a slide, a photo's canvas, a video. */
const STAGED = "picture img, canvas, video";

/** The --ease-out token, for the pill's glide and the photo's fade. */
const easeOut = () => getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim();

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
  const end = byId("b-end");
  const stop = byId("b-stop");
  const body = document.body;
  const presenting = () => body.classList.contains("is-presenting");
  // Placement is `placeControls` (core/demo.js), applied and glided here. Offsets, not client rects: the swap scales the img.
  let lastPlace = "";
  /** @type {DOMRect | null} where the controls were last drawn */
  let drawn = null;
  const fit = () => {
    // From where they were drawn (their content changed first), or mid-glide.
    const running = pill.getAnimations?.() ?? [];
    const from = running.length ? pill.getBoundingClientRect() : (drawn ?? pill.getBoundingClientRect());
    for (const a of running) a.cancel();
    const swap = swapped;
    swapped = false;
    /** @type {any} a slide, a photo's canvas, a video, or their loader */
    const img = frame.querySelector(STAGED) ?? frame.querySelector(".stand-in");
    const item = frame.classList.contains("is-scroll") ? null : (img ?? frame.firstElementChild);
    const css = getComputedStyle(view);
    const inset = parseFloat(css.getPropertyValue("--inset"));
    const pillH = parseFloat(css.getPropertyValue("--pill"));
    const stackW = parseFloat(css.getPropertyValue("--stack"));
    // A photo, a video or their loader: the --ratio paint() sets, 3 : 2 until known.
    const ratio = !img
      ? 0
      : img.naturalWidth
        ? img.naturalWidth / img.naturalHeight
        : parseFloat(img.style.getPropertyValue("--ratio")) || 1.5;
    const stage = { w: view.offsetWidth, h: view.offsetHeight };
    const w = Math.min(stage.w, stage.h * ratio);
    // The column's height is read with it on.
    pane.classList.toggle("is-stacked", true);
    const stackH = pill.offsetHeight;
    const listed = !side.hidden && matchMedia("(min-width: 760px)").matches;
    // The list's full height, not its box: on the rail its cap reserves the stack, so the box would always fit.
    const railFits =
      listed &&
      side.getBoundingClientRect().top + side.scrollHeight + inset + stackH <= end.getBoundingClientRect().bottom;
    let place = /** @type {"under" | "right" | "rail" | "float"} */ (item ? "under" : "float");
    if (ratio && listed)
      place = placeControls({ w, h: w / ratio }, stage, { pill: pillH, stackW, stackH, inset, rail: railFits });
    pane.classList.toggle("is-stacked", place === "right" || place === "rail");
    pane.classList.toggle("is-under", place === "under");
    // A list that grows while the stack is on the rail scrolls above it (app.css, the rail's .side cap).
    if (place === "rail") side.style.setProperty("--reserve", `${stackH}px`);
    else side.style.removeProperty("--reserve");
    if (place === "right") {
      pill.style.top = `${view.offsetTop + stage.h - stackH}px`;
      pill.style.left = `${view.offsetLeft + stage.w - stackW}px`;
    } else if (place === "rail") {
      const [s, o] = [side.getBoundingClientRect(), pane.getBoundingClientRect()];
      pill.style.top = `${end.getBoundingClientRect().bottom - stackH - o.top}px`;
      pill.style.left = `${s.right - o.left - stackW}px`;
    } else {
      pill.style.top = `${view.offsetTop + (place === "under" && item instanceof HTMLElement ? item.offsetTop + item.offsetHeight + inset : stage.h - inset - pill.offsetHeight)}px`;
      pill.style.left = "";
    }
    const now = pill.getBoundingClientRect();
    drawn = now;
    const was = lastPlace;
    lastPlace = place;
    // Only a change of place, shape or item glides (FLIP: from where they were drawn); a resize moves them at once.
    const differs = (/** @type {"left" | "top" | "width" | "height"} */ k) => Math.abs(from[k] - now[k]) >= 1;
    const reshaped = differs("width") || differs("height");
    if (
      (reshaped || ((swap || (was && was !== place)) && (differs("left") || differs("top")))) &&
      from.width &&
      !presenting() &&
      !reduced.matches
    ) {
      const bx = place === "under" || place === "float" ? "-50%" : "0px";
      pill.animate(
        [
          {
            translate: `calc(${bx} + ${from.left - now.left}px) ${from.top - now.top}px`,
            scale: `${from.width / now.width} ${from.height / now.height}`,
            transformOrigin: "0 0",
          },
          { translate: `${bx} 0`, scale: "1 1", transformOrigin: "0 0" },
        ],
        { duration: 300, easing: easeOut() },
      );
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
  // The entry slides the pane 12 px, which the list does not share.
  pane.addEventListener("animationend", fit);
  // The ratio, so the place, is known once the image has loaded.
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
  /** The nodes waiting on an image decode: a stale swap must not land. @type {unknown} */
  let building = null;
  /** The stage's content just changed. */
  let swapped = false;
  // Per-item state is keyed by idOf: a file sorting in ahead shifts every position.
  /** @type {Map<string, Shot>} */
  const images = new Map();
  /** @type {Map<number, Shot>} taken before the first render */
  const early = new Map();
  /** The loader on the stage and the item it stands in for: progress lands on it, and the photo fades in over it. */
  let waiting = /** @type {{key: string, part: HTMLElement} | null} */ (null);
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
  /** An item's identity: kind, name or title, and the count of same-named items before it (the protocol has no id).
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

  /** An unplayable video says so; the pill's Download is the way on. @param {Item} item */
  function card(item, unplayable = false) {
    const host = item.kind === "link" ? hostOf(item.url) : "";
    return el("div", unplayable ? { class: "item-card", role: "alert" } : { class: "item-card" }, [
      tile(itemIcon(item)),
      el("p", { class: "item-title" }, [unplayable ? CANT_PLAY : host || itemName(item)]),
      el("p", { class: "small" }, [item.kind === "link" ? item.title : itemLine(item)]),
      ...(item.kind === "link"
        ? [linkTo(item.url, { class: "btn primary" }, [`Open ${host}`, el("span", { class: "sr" }, [" in a New Tab"])])]
        : []),
    ]);
  }

  function image(/** @type {number} */ i) {
    const key = keyOf(i);
    const shot = images.get(key);
    if (shot || asked.has(key) || refused.has(key)) return shot ?? null;
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
    // A guest's deck or PDF has no pages, only a card.
    const photo = !p && onStage(item);
    const key = keyOf(at);
    const shot = photo ? image(at) : null;
    const img = shot?.ready ? shot.node : null;
    const loading = photo && !img && !shot?.failed && !refused.has(key);
    arriving = loading;
    const want = p ? `p${at}:${scroll ? "all" : page}` : img ? `i${at}` : loading ? `w${at}` : `c${at}`;
    if (want !== framed) {
      framed = want;
      /** @type {HTMLElement[]} */
      let nodes;
      if (scroll && p) nodes = p.map((base, n) => picture(base, n, p.length));
      else if (p) nodes = [picture(p[page] ?? "", page, p.length)];
      else if (img) {
        img.setAttribute("aria-label", itemName(item));
        nodes = [img];
      } else if (loading) {
        // While the photo loads, the loader holds the stage in its box, over the row's thumbnail.
        if (waiting?.key !== key) {
          const part = loader(itemName(item), thumbOf(item, v));
          part.classList.add("stand-in");
          waiting = { key, part };
        }
        nodes = [waiting.part];
      } else nodes = [card(item, !!shot?.failed && !!shot.video)];
      const commit = () => {
        if (building !== nodes) return;
        building = null;
        seen.disconnect();
        view.classList.toggle("is-card", !p && !img && !loading);
        frame.classList.toggle("is-scroll", scroll);
        // A photo replacing its own loader fades in over it; anything else swaps at once.
        const over = img && waiting?.key === key && frame.firstElementChild === waiting.part ? waiting.part : null;
        frame.replaceChildren(...(over ? [over] : []), ...nodes);
        if (!loading) waiting = null;
        if (img && over)
          img
            .animate({ opacity: [0, 1] }, { duration: reduced.matches ? 0 : 200, easing: easeOut() })
            .finished.catch(() => {})
            .then(() => over.remove());
        if (scroll && p) for (const one of frame.querySelectorAll("img")) seen.observe(one);
        sized.disconnect();
        // The picture over its fading loader: the loader leaves, the picture's box is the one fit() reads.
        const target = frame.querySelector(STAGED) ?? frame.querySelector(".stand-in") ?? frame.firstElementChild;
        // The pill (its buttons appear after the item) and the list (it grows with a guest's file) set the place too.
        for (const box of [target, view, pill, side, end]) if (box) sized.observe(box);
        swapped = true;
      };
      building = nodes;
      // The old item stays until the new one has decoded.
      const first = /** @type {HTMLImageElement | undefined} */ (
        nodes.map((n) => n.querySelector?.("img") ?? n).find((n) => "decode" in n)
      );
      if (frame.firstElementChild && first && !first.complete)
        first
          .decode()
          .catch(() => {})
          .then(commit);
      else commit();
    }
    if (loading && waiting) setProgress(waiting.part, shot?.fraction ?? null);
    // Loader and item share one box (app.css).
    if (shot?.ratio) (img ?? waiting?.part)?.style.setProperty("--ratio", String(shot.ratio));
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
    for (const shot of [...images.values(), ...early.values()]) shot.stop();
    images.clear();
    early.clear();
    waiting = null;
    building = null;
    drawn = null;
    lastPlace = "";
    asked.clear();
    refused.clear();
    seen.disconnect();
    list.replaceChildren();
    frame.replaceChildren();
    built = framed = null;
    at = page = 0;
    parked = false;
    hide();
    // A hidden stage while presenting is a black screen: only a real end leaves it.
    present(false);
  }

  /** Pages, a loaded photo or a playable video; a link or a file card has nothing to present. */
  const presentable = () => !!pages() || !!images.get(keyOf(at))?.ready;
  let arriving = false;
  let sleep = 0;
  /** @type {HTMLElement | null} */
  let opener = null;
  /** The one way in and out of presenting: the page's layout, which browser full screen then joins. */
  function present(/** @type {boolean} */ on) {
    if (on === presenting()) return;
    if (on) opener = /** @type {HTMLElement | null} */ (document.activeElement);
    body.classList.toggle("is-presenting", on);
    show(stop, on);
    // Focus follows the layout, never dropping to the body; on a video, so Space plays and pauses, not Stop.
    if (on) (frame.querySelector("video") ?? stop).focus?.({ preventScroll: true });
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
  // Stop Presenting: opacity follows the pointer's distance from the top (0 beyond BAND + RAMP, 1 within BAND), a click
  // from half; a touch tap shows it for 3 s.
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
    still = setTimeout(() => y > band && aim(Number.POSITIVE_INFINITY), 1000);
    cursor = setTimeout(() => view.classList.add("is-idle"), 2000);
  }
  /** Stop Presenting shows for 3 s after a tap. */
  function awake() {
    view.classList.add("is-awake");
    clearTimeout(sleep);
    sleep = setTimeout(() => view.classList.remove("is-awake"), 3000);
  }

  // Leaving full screen ends presenting; a held stage then hides.
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
    /** null takes the viewer down and drops every image. */
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

    /** A transient state hides the stage; presenting, it stays with a status line. @param {string} line */
    park(line) {
      parked = true;
      // A hidden video would play on unseen.
      frame.querySelector("video")?.pause();
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
      // Before the first render there is no list: it waits by position.
      const was = shown ? images.get(keyOf(item)) : early.get(item);
      // A photo or video already on stage stays: a fresh link for it would only put its loader back.
      if (was?.ready) return true;
      was?.stop();
      const done = () => deps.onChange();
      const shot = isVideoLink(target)
        ? film(target, done)
        : shoot(target, (s) => waiting && images.get(waiting.key) === s && setProgress(waiting.part, s.fraction), done);
      if (!shown) early.set(item, shot);
      else {
        images.set(keyOf(item), shot);
        asked.delete(keyOf(item));
      }
      framed = null;
      if (shown) paint();
      return true;
    },

    item: () => (shown ? (items()[at] ?? null) : null),
    at: () => at,

    presentable,
    /** The photo on stage is still on its way. */
    arriving: () => arriving,
    present,
  };
}
