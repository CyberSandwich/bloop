// The demo viewer (DEMO-01, design.md section 7): the page fetches the launched link itself.
// A photo or a video is kept for the session: a second mint spends the budget.
/** @import {Item, OpenMode, ScreenView, Sound} from "../../src/shared/protocol.ts" */
/** @import {Minted} from "./types.js" */
import { CANT_PLAY } from "./core/copy-screen.js";
import { halves, isVideoLink, openTarget, pageMode, pagesOf, placeControls, stepPage, thumbOf } from "./core/demo.js";
import { hostOf, isVideo, itemIcon, itemLine, itemName } from "./core/format.js";
import { ICONS } from "./core/icons.js";
import { loader, readAll, setProgress } from "./core/loader.js";
import { linkRow, linkTo, rowFace, tile } from "./core/rows.js";
import { onStage } from "./core/states.js";
import { byId, el, icon, setText, show } from "./core/ui.js";
import { TUNE, tuneOf } from "./shared/session.js";

/** @typedef {{play: boolean, sound: Sound}} Tune */
/** @typedef {{node?: HTMLCanvasElement | HTMLVideoElement, ratio?: number | null, ready: boolean, failed: boolean, fraction: number | null, stop: () => void, tune?: (want: Tune, retune: (next: Tune) => void) => void}} Shot */

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

/** viewer-video.js fills it in. @param {string} url @param {(shot: Shot) => void} onChange */
function film(url, onChange) {
  let live = true;
  /** @type {Shot} */
  const shot = {
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

/**
 * @param {{relink: (item: number) => Promise<Minted>, onChange: () => void, tapped?: () => void, busy?: () => boolean}} deps
 * tapped: a tap here changed what it shows; busy: its report is on its way
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
  /** Where the page count's segment is going: shown, or collapsing and then hidden (setDots). */
  let dotsOn = !dots.hidden;
  const note = byId("parked");
  const pill = byId("controls");
  const pane = byId("pane");
  const end = byId("b-end");
  const stop = byId("b-stop");
  const tapSound = byId("b-sound");
  const body = document.body;
  const presenting = () => body.classList.contains("is-presenting");
  // Placement is `placeControls` (core/demo.js), applied and glided here. Offsets, not client rects: the swap scales the img.
  let lastPlace = "";
  /** @type {DOMRect | null} where the controls were last drawn */
  let drawn = null;
  let drawnIn = 0;
  const fit = () => {
    const win = innerWidth * 1e5 + innerHeight;
    const resized = drawnIn > 0 && drawnIn !== win;
    const running = pill.getAnimations?.() ?? [];
    const from = running.length ? pill.getBoundingClientRect() : (drawn ?? pill.getBoundingClientRect());
    const held = resized ? null : drawn;
    // Lifted off to measure: a glide to the same target runs on, not restarts.
    for (const a of running) /** @type {KeyframeEffect} */ (a.effect).target = null;
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
    drawnIn = win;
    const was = lastPlace;
    lastPlace = place;
    // Only a change of place glides (FLIP: from where they were drawn). A new item in the same place moves it in the
    // same frame as the stage, and its width changes by the page count alone (setDots), so its center holds.
    const differs = (/** @type {"left" | "top" | "width" | "height"} */ k, a = from) => Math.abs(a[k] - now[k]) >= 1;
    const reshaped = differs("width") || differs("height");
    const holds =
      held && !differs("left", held) && !differs("top", held) && !differs("width", held) && !differs("height", held);
    for (const a of running)
      if (holds) /** @type {KeyframeEffect} */ (a.effect).target = pill;
      else a.cancel();
    if (
      !holds &&
      !resized &&
      was &&
      was !== place &&
      (reshaped || differs("left") || differs("top")) &&
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
  // Per-item state is keyed by the server's item id (`keyOf`): a file sorting in ahead shifts every position.
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
      const was = page;
      for (const e of entries) if (e.isIntersecting) page = Number(e.target.getAttribute("data-page"));
      paintDots();
      if (page !== was) deps.tapped?.();
    },
    { root: frame, threshold: 0.5 },
  );

  const items = () => shown?.items ?? [];
  const keyOf = (/** @type {number} */ i) => items()[i]?.id ?? "";
  /** Presenting as asked, held until the item can present. */
  let want = false;
  let followed = "";
  /** A video's play state (design.md section 7, Video), and what the one on stage was last set to. */
  /** @type {Tune} */
  let tune = { ...TUNE };
  let tuned = "";
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

  /** Present holds for pages, or a photo or video on its way. */
  const can = () => !!pages() || onStage(items()[at] ?? null);
  /** Presentable now or when its photo lands: a re-present has no gesture for full screen. */
  const alive = () => can() && !images.get(keyOf(at))?.failed && !refused.has(keyOf(at));

  /** The page each item was left on, by server id; a session's end empties it (clear). @type {Map<string, number>} */
  const lastPage = new Map();
  /** Remembers the page of the item on stage before another takes its place. */
  const leave = () => lastPage.set(keyOf(at), page);

  function select(/** @type {number} */ i) {
    // A new item starts as a phone's command starts it: playing, sound tried again; the same one keeps its state.
    if (i !== at) tune = { ...TUNE };
    // A deck left on page 3 comes back on page 3; the row of the item already on stage starts it over.
    const back = i !== at ? (lastPage.get(items()[i]?.id ?? "") ?? 0) : 0;
    leave();
    at = i;
    page = Math.min(back, Math.max(0, (pages()?.length ?? 1) - 1));
    want &&= can();
    if (side.matches(":popover-open")) side.hidePopover();
    deps.onChange();
    deps.tapped?.();
  }

  function go(/** @type {number} */ by, /** @type {number} */ to = -1) {
    const p = pages();
    if (!p || parked) return;
    const was = page;
    page = stepPage(to < 0 ? page : to, to < 0 ? by : 0, p.length);
    if (tall.has(keyOf(at))) frame.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
    else paint();
    if (to < 0 && page !== was) deps.tapped?.();
  }

  function ask(/** @type {boolean} */ on) {
    if (on === want && on === presenting()) return;
    want = on;
    present(on);
    deps.tapped?.();
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
            ? linkRow(item.url, "item", face)
            : el("button", { type: "button", class: "item" }, face);
        if (item.kind === "file") row.addEventListener("click", () => select(i));
        const split = item.kind === "link" && files > 0 && files === i;
        if (item.kind === "file") files += 1;
        const p = pagesOf(item, v);
        for (const s of p ?? []) new Image().src = `${s}.avif`;
        return el("li", split ? { class: "split" } : {}, [row]);
      }),
    );
  }

  /** @param {Item} item */
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

  /**
   * The page count comes and goes as one segment of the pill: its width, padding and the gap after it, with its
   * opacity, so the pill keeps its center and Present and Download slide. At once while presenting, stacked or under
   * reduced motion. @param {boolean} on
   */
  function setDots(on, now = false) {
    const running = dots.getAnimations?.() ?? [];
    const instant = now || reduced.matches || presenting() || pane.classList.contains("is-stacked");
    // Every scroll repaints: the same target leaves a running segment alone, or the width would restart from 0.
    if (on === dotsOn && !(instant && running.length)) return;
    dotsOn = on;
    const [flight] = running;
    if (flight && !instant && running.length === 1) {
      flight.onfinish = on ? null : () => show(dots, false);
      return flight.reverse();
    }
    for (const a of running) a.cancel();
    show(dots, true);
    if (instant) return show(dots, on);
    const css = getComputedStyle(dots);
    const full = { width: `${dots.offsetWidth}px`, opacity: 1, paddingInline: css.paddingInline, marginRight: "0px" };
    const none = {
      width: "0px",
      opacity: 0,
      paddingInline: "0px",
      marginRight: `-${getComputedStyle(pill).columnGap}`,
    };
    const a = dots.animate(on ? [none, full] : [full, none], { duration: 300, easing: easeOut() });
    if (!on) a.onfinish = () => show(dots, false);
  }

  function paintDots() {
    const p = pages();
    if (parked) return;
    // The text first: a growing segment is measured with it.
    if (p) {
      prev.disabled = page === 0;
      next.disabled = page === p.length - 1;
      setText(dots, `${page + 1} / ${p.length}`);
    }
    setDots(!!p && p.length > 1);
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
    const loading = photo && !img && alive();
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
      } else nodes = [card(item, !!shot?.failed && isVideo(item))];
      const commit = () => {
        if (building !== nodes) return;
        building = null;
        seen.disconnect();
        view.classList.toggle("is-card", !p && !img && !loading);
        frame.classList.toggle("is-scroll", scroll);
        // A photo replacing its own loader fades in over it; anything else swaps at once.
        const over = img && waiting?.key === key && frame.firstElementChild === waiting.part ? waiting.part : null;
        const leaving = frame.querySelector("video");
        if (!nodes.some((n) => n === leaving || n.contains?.(leaving))) hush(leaving);
        frame.replaceChildren(...(over ? [over] : []), ...nodes);
        if (!loading) waiting = null;
        if (img && over)
          img
            .animate({ opacity: [0, 1] }, { duration: reduced.matches ? 0 : 200, easing: easeOut() })
            .finished.catch(() => {})
            .then(() => over.remove());
        if (scroll && p) {
          frame.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
          for (const one of frame.querySelectorAll("img")) seen.observe(one);
        }
        sized.disconnect();
        // The picture over its fading loader: the loader leaves, the picture's box is the one fit() reads.
        const target = frame.querySelector(STAGED) ?? frame.querySelector(".stand-in") ?? frame.firstElementChild;
        // The pill (its buttons appear after the item) and the list (it grows with a guest's file) set the place too.
        for (const box of [target, view, pill, side, end]) if (box) sized.observe(box);
        // A swap moves or replaces the video: it is set again.
        tuned = "";
        play();
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
    // Loader and item share one box (app.css); a video's loader is the stage's shape until the metadata.
    const ratio = shot?.ratio || (isVideo(item) && view.offsetWidth / view.offsetHeight);
    if (ratio) (img ?? waiting?.part)?.style.setProperty("--ratio", String(ratio));
    show(view, true);
    show(frame, true);
    show(note, false);
    show(prev, !!p && !scroll && p.length > 1);
    show(next, !!p && !scroll && p.length > 1);
    paintDots();
    play();
  }

  /** Off the stage or parked, a video stops and reports nothing: its events would retune the item after it. */
  const hush = (/** @type {HTMLVideoElement | null} */ v) => {
    if (!v) return;
    v.onplay = v.onpause = v.onvolumechange = null;
    v.pause();
  };

  /** The current item's video when it is the one in the frame: never another video still showing in its place. */
  const staged = () => {
    const shot = parked ? undefined : images.get(keyOf(at));
    return shot?.tune && shot.node && frame.contains(shot.node) ? shot : undefined;
  };

  /** Sets the video on stage to `tune`, once per change (viewer-video.js); what it reports back is reported on. */
  function play() {
    const set = staged()?.tune;
    show(tapSound, !!set && tune.sound === "blocked");
    const key = set ? keyOf(at) + tune.play + tune.sound : "";
    if (key === tuned) return;
    tuned = key;
    const mine = keyOf(at);
    set?.(tune, (/** @type {Tune} */ next) => {
      // A late answer for an item no longer on stage, or while parked, is not this one's.
      if (parked || keyOf(at) !== mine || (next.play === tune.play && next.sound === tune.sound)) return;
      tune = next;
      tuned = "";
      play();
      deps.tapped?.();
    });
  }

  function hide() {
    for (const part of [side, handle, view]) show(part, false);
    setDots(false, true);
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
    lastPage.clear();
    seen.disconnect();
    list.replaceChildren();
    frame.replaceChildren();
    built = framed = null;
    at = page = 0;
    parked = want = false;
    followed = tuned = "";
    tune = { ...TUNE };
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
  function present(/** @type {boolean} */ on, told = false) {
    if (on === presenting()) return;
    if (on) opener = /** @type {HTMLElement | null} */ (document.activeElement);
    body.classList.toggle("is-presenting", on);
    show(stop, on);
    // Focus follows the layout, and on a video so Space plays it; not for the phone's command (focus-visible would pin
    // Stop over the slide).
    if (!on) opener?.focus?.({ preventScroll: true });
    else if (!told) (frame.querySelector("video") ?? stop).focus?.({ preventScroll: true });
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
    if (presenting()) ask(false);
    if (parked) hide();
  });
  stop.addEventListener("click", () => ask(false));
  let swipe = 0;
  let swiped = false;
  view.addEventListener("pointerdown", (e) => {
    // Only pages swipe: a drag on a video scrubs.
    swipe = pages() ? e.clientX : Number.NaN;
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
  // The gesture sound, and a play refused even muted, need; the video's own events then report it.
  tapSound.addEventListener("click", () => {
    const video = /** @type {HTMLVideoElement | undefined} */ (staged()?.node);
    if (!video) return;
    video.muted = false;
    if (video.paused) video.play().catch(() => {});
  });
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  /** First or last page, reported to the phone as a tap here is. */
  function jump(/** @type {number} */ to) {
    const was = page;
    go(0, to);
    if (page !== was) deps.tapped?.();
  }
  const typing = (/** @type {EventTarget | null} */ t) =>
    t instanceof Element && (side.contains(t) || t.matches("input, textarea"));
  let clicker = false;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ask(false);
    const step = KEYS[e.key];
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
    if (!shown || parked || !step || !plain || !pages() || typing(e.target)) return;
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
      const id = keyOf(at);
      shown = nextView;
      parked = false;
      if (!clicker && nextView.items.length) {
        clicker = true;
        void import("./core/clicker.js").then((m) =>
          m.clickerKeys({ live: () => !!shown && !parked, typing, presenting, can, pages: () => !!pages(), ask, jump }),
        );
      }
      for (const [i, img] of early) images.set(keyOf(i), img);
      early.clear();
      const key = JSON.stringify(nextView.items);
      if (key !== built) {
        built = key;
        framed = null;
        // A file joining the list ahead of the selection must not change what is on screen.
        const moved = nextView.items.findIndex((x) => x.id === id);
        at = moved >= 0 ? moved : Math.max(0, Math.min(at, nextView.items.length - 1));
        buildList();
      }
      // Followed once, and never while a tap here is on its way.
      const told = nextView.shown;
      const sig = JSON.stringify(told);
      if (told && sig !== followed && !deps.busy?.()) {
        followed = sig;
        const i = nextView.items.findIndex((x) => x.id === told.item);
        if (i >= 0) {
          if (i !== at) {
            leave();
            page = 0;
          }
          at = i;
          want = told.present && can();
          tune = tuneOf(told);
          go(0, told.page - 1);
        }
      }
      if (presenting() && !(want && alive())) present(false);
      else if (want && !presenting() && presentable()) present(true, true);
      paint();
    },

    /** As `POST /api/screen/shown` takes it; a link's card is page 1. */
    shown() {
      const item = items()[at];
      return item ? { item: item.id, page: page + 1, present: want, ...tune } : null;
    },

    /** A transient state hides the stage; presenting, it stays with a status line. @param {string} line */
    park(line) {
      parked = true;
      // A hidden video would play on unseen; unparked, it is set again (as off the stage, paint).
      hush(frame.querySelector("video"));
      show(tapSound, false);
      tuned = "";
      if (!presenting()) return hide();
      for (const part of [frame, prev, next]) show(part, false);
      setText(note, line);
      show(note, true);
    },

    /** A link the launcher would open in a window. @param {string} url @param {number} item @param {OpenMode} mode */
    take(url, item, mode) {
      const target = openTarget(url, location.origin);
      if (mode !== "view") return !!target && fetchOpen(target);
      // Before the first render there is no list: it waits by position.
      const was = shown ? images.get(keyOf(item)) : early.get(item);
      // On stage, it stays: a fresh link would only put its loader back.
      if (was?.ready) return true;
      was?.stop();
      const done = () => deps.onChange();
      // Off this origin: the card, never a window retry.
      const shot = !target
        ? { ready: false, failed: true, fraction: null, stop() {} }
        : isVideoLink(target)
          ? film(target, done)
          : shoot(
              target,
              (s) => waiting && images.get(waiting.key) === s && setProgress(waiting.part, s.fraction),
              done,
            );
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
    present: ask,
  };
}
