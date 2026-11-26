// The Present sheet (present-live.md section 2): how to reach the room screen, what opens first, and which uploads
// will not go. Done closes it; Enter the Code goes to /code for a QR the camera cannot read.
/** @import {Row} from "./model.js" */
import { presentLine, stillUploading } from "../core/copy-library.js";
import { el } from "../core/ui.js";
import { allRows, opensFirst, pending } from "./model.js";

/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @param {HTMLElement | null} opener */
  async function open(opener) {
    const list = page.list();
    if (!list) return;
    const first = opensFirst(list);
    const uploading = allRows(list).filter((/** @type {Row} */ r) => pending(r));
    const done = el("button", { class: "btn primary", type: "button", "data-close": "" }, ["Done"]);
    const code = el("a", { class: "btn secondary", href: "/code" }, ["Enter the Code"]);
    await page.sheet(
      "present-title",
      [
        el("div", { class: "lib-sheet-head" }, [
          el("h2", { id: "present-title", tabindex: "-1" }, ["Present on a Screen"]),
          page.closer(),
        ]),
        el("div", { class: "lib-body" }, [
          el("p", {}, [page.glyph("monitor"), " ", presentLine(location.host)]),
          el(
            "p",
            { class: "lib-first" },
            first
              ? ["Opens first: ", el("strong", {}, [first.name]), first.tail]
              : ["Choose your files after you scan."],
          ),
          ...uploading.map((/** @type {Row} */ r) => el("p", {}, [stillUploading(r.name)])),
        ]),
        // Stacked under 640 with Done on top; side by side from 640 with Done last (.buttons).
        el("div", { class: "buttons" }, [code, done]),
      ],
      opener,
    );
  }
  return { open };
}
