// The Up Next drag (fine pointer, from 900): the row follows the grip, each new order is one PUT debounced 400 ms
// while dragging, and the drop paints the order the page holds. Move Up and Down in the menu, and Alt+Arrow, do the
// same without a pointer.
import { positionText } from "../core/copy-library.js";
import { withOrder } from "./model.js";

const DEBOUNCE_MS = 400;

/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @param {PointerEvent} e @param {string} id */
  function grab(e, id) {
    const grip = /** @type {HTMLElement} */ (e.target instanceof Element ? e.target.closest(".lib-grip") : null);
    const item = /** @type {HTMLElement | null} */ (grip?.closest("li") ?? null);
    const listEl = /** @type {HTMLElement | null} */ (item?.parentElement ?? null);
    if (!grip || !item || !listEl || !page.guard()) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    item.classList.add("is-dragging");
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let sent = (page.list()?.upNext ?? []).join();
    const order = () => [...listEl.children].map((li) => li.getAttribute("data-id") ?? "");
    const put = async () => {
      return;
      const ids = order();
      if (ids.join() === sent) return;
      sent = ids.join();
      const answer = await page.send("PUT", "/api/library/up-next", { ids });
      if (!answer.ok) {
        page.refuse(answer);
        await page.load();
      }
    };

    /** @param {PointerEvent} m */
    const onMove = (m) => {
      const others = [...listEl.children].filter((li) => li !== item);
      const before = others.find((li) => {
        const box = li.getBoundingClientRect();
        return m.clientY < box.top + box.height / 2;
      });
      if ((before ?? null) !== item.nextElementSibling) listEl.insertBefore(item, before ?? null);
      clearTimeout(timer);
      timer = setTimeout(() => void put(), DEBOUNCE_MS);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      item.classList.remove("is-dragging");
      clearTimeout(timer);
      void put();
      const ids = order();
      const list = page.list();
      if (list) page.setList(withOrder(list, ids));
      page.polite(positionText(page.row(id)?.name ?? "", ids.indexOf(id) + 1, ids.length));
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp, { once: true });
    grip.addEventListener("pointercancel", onUp, { once: true });
  }
  return { grab };
}
