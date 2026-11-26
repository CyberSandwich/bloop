// The preview sheet (library.md section 5): the slides or pages from the converter's outputs, a picture, or a video,
// behind a 5-minute `/p/` link minted on the row's pointerdown. A file it cannot show gets the file card with
// Download. P2's viewers (sheets, text) are not here.
/** @import {Row} from "./model.js" */
import { fontSentence, kindOf, pagesWord, reasonOf, sizeText, T } from "../core/copy-library.js";
import { loader } from "../core/loader.js";
import { el, setText } from "../core/ui.js";
import { canTick } from "./model.js";

/** A link refreshes this long before it lapses, so a step never fetches with a dead one. */
const EARLY_MS = 15_000;
/** "Preparing" this long reads as slow (states.md section 3). */
const LONG_MS = 5 * 60_000;
const SWIPE_PX = 50;

/**
 * Page `n` (1-based) of the converter's output under a bundle link, 1920 wide on a desk, 480 on a phone.
 * @param {string} base @param {number} n @param {boolean} wide
 */
// transitional: P1: the /p/ handler's bundle layout is P1's; only t.webp is fixed so far, and this names its pages
const pageUrl = (base, n, wide) => `${base}/${wide ? 1920 : 480}/${n}.webp`;

/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @type {Map<string, Promise<{base: string, exp: number} | {code: string}>>} */
  const links = new Map();

  /** @param {Row} row */
  const assetOf = (row) => (["image", "film"].includes(kindOf(row.ext).glyph) ? "original" : "bundle");
  /** @param {Row} row */
  const showable = (row) =>
    page.list()?.switches.previews === "on" &&
    !row.disabled &&
    (assetOf(row) === "original" || (row.derived.state === "ready" && (row.derived.pages ?? 0) > 0));

  /** @param {string} id @param {boolean} [fresh] @returns {Promise<{base: string, exp: number} | {code: string}>} */
  function link(id, fresh = false) {
    const row = page.row(id);
    if (!row) return Promise.resolve({ code: "not_found" });
    const key = `${id}:${assetOf(row)}`;
    const held = links.get(key);
    if (held && !fresh) return held;
    const made = page.net
      .call("POST", `${page.path(id)}/preview`, { asset: assetOf(row) })
      .then((/** @type {any} */ a) =>
        a.ok ? { base: String(a.value.base), exp: Number(a.value.exp) } : { code: a.code },
      );
    links.set(key, made);
    return made;
  }

  /** The row's pointerdown: the link is on its way before the tap lands. @param {string} id */
  function prefetch(id) {
    const row = page.row(id);
    if (row && showable(row)) void link(id);
  }

  /** @param {string} id @param {HTMLElement | null} opener */
  async function open(id, opener) {
    const row = page.row(id);
    if (!row || row.disabled) return;
    const wide = matchMedia("(min-width: 900px)").matches;
    const title = el("h2", { id: "preview-title", tabindex: "-1" }, [row.name]);
    const line = el("p", { class: "small" }, []);
    const stage = el("div", { class: "lib-stage" });
    const notes = el("div", { class: "lib-body" });
    const actions = el("div", { class: "buttons" });
    const dialog = await page.sheet(
      "preview-title",
      [el("div", { class: "lib-sheet-head" }, [title, page.closer()]), line, stage, notes, actions],
      opener,
      "lib-preview",
    );
    const started = Date.now();
    let n = 1;
    let shownState = "";
    /** @type {{base: string, exp: number} | null} */
    let current = null;

    const gone = () => {
      dialog.close();
      page.say({ title: T.gone, body: "" });
    };

    /** The link for the next step, minted again once it is near its end; a refusal closes the sheet. */
    async function fresh() {
      if (current && current.exp - Date.now() > EARLY_MS) return current;
      const got = await link(id, current !== null);
      if ("code" in got) {
        if (got.code === "not_found") gone();
        return null;
      }
      current = got;
      return got;
    }

    async function paintStage() {
      const now = page.row(id);
      if (!now) return gone();
      shownState = now.derived.state;
      const kind = kindOf(now.ext);
      const pages = now.derived.pages ?? 0;
      setText(line, [kind.word, sizeText(now.bytes), ...(pages ? [pagesWord(now.ext, pages)] : [])].join(" · "));
      const fonts = now.derived.fontsMissing ?? [];
      notes.replaceChildren(
        ...(fonts.length ? [el("p", { class: "lib-fonts" }, [page.glyph("triangle-alert"), fontSentence(fonts)])] : []),
      );
      if (now.derived.state === "preparing" && kind.glyph !== "image" && kind.glyph !== "film") {
        const slow = Date.now() - started > LONG_MS || Date.now() - now.updatedAt > LONG_MS;
        return stage.replaceChildren(
          loader(now.name, now.thumb ?? null),
          el("p", { class: "small" }, [T.previewPreparing, ...(slow ? [" ", T.previewSlow] : [])]),
        );
      }
      if (!showable(now)) {
        const reason = now.derived.state === "failed" ? reasonOf(now.refusal) : "";
        return stage.replaceChildren(
          el("div", { class: "lib-card" }, [
            page.tile({ ...now, thumb: undefined }),
            ...(reason ? [el("p", {}, [reason])] : []),
          ]),
        );
      }
      const got = await fresh();
      if (!got) return;
      if (kind.glyph === "film")
        return stage.replaceChildren(el("video", { src: got.base, controls: "", preload: "metadata" }));
      if (kind.glyph === "image") return stage.replaceChildren(el("img", { src: got.base, alt: now.name }));
      const img = el("img", {
        src: pageUrl(got.base, n, wide),
        alt: `${pagesWord(now.ext, 1).replace(/^1 /, "")} ${n}`,
      });
      const prev = el("button", { class: "lib-half", type: "button", "aria-label": "Previous" });
      const next = el("button", { class: "lib-half next", type: "button", "aria-label": "Next" });
      prev.addEventListener("click", () => step(-1));
      next.addEventListener("click", () => step(1));
      stage.replaceChildren(img, prev, next, el("p", { class: "small lib-count" }, [`${n} / ${pages}`]));
    }

    /** @param {number} delta */
    function step(delta) {
      const pages = page.row(id)?.derived.pages ?? 0;
      const to = Math.min(pages, Math.max(1, n + delta));
      if (to === n) return;
      n = to;
      void paintStage();
    }

    let x0 = 0;
    stage.addEventListener("pointerdown", (e) => {
      x0 = e.clientX;
    });
    stage.addEventListener("pointerup", (e) => {
      if (Math.abs(e.clientX - x0) > SWIPE_PX) step(e.clientX < x0 ? 1 : -1);
    });
    dialog.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    });

    function paintActions() {
      const now = page.row(id);
      if (!now) return;
      const download = el("button", { class: "btn secondary", type: "button" }, [T.download]);
      download.addEventListener("click", () => void page.download(id));
      /** @type {HTMLElement[]} */
      const parts = [download];
      if (wide) {
        const rename = el("button", { class: "btn secondary", type: "button" }, [T.rename]);
        rename.addEventListener("click", () => {
          dialog.close();
          void page.openMenu(id, opener, "rename");
        });
        parts.push(rename);
      }
      if (canTick(now)) {
        const tick = el("button", { class: "btn primary", type: "button" }, [now.selected ? T.removeUp : T.addUp]);
        tick.addEventListener("click", async () => {
          await page.setTick(id, !now.selected);
          paintActions();
          /** @type {HTMLElement | null} */ (actions.querySelector(".btn.primary"))?.focus();
        });
        parts.push(tick);
      }
      actions.replaceChildren(...parts);
    }

    // The socket's `ready` refetches the list; the sheet turns into the slides without closing.
    const watcher = setInterval(() => {
      const now = page.row(id);
      if (!now) return gone();
      if (now.derived.state !== shownState) void paintStage();
    }, 1000);
    dialog.addEventListener("close", () => clearInterval(watcher));

    paintActions();
    await paintStage();
  }

  return { prefetch, open };
}
