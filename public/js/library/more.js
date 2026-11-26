// The list's next page of 200 (library.md section 2), fetched when the last row comes into view: only a library past
// 200 files ever loads this.
/** @import {List} from "./model.js" */

/** @param {any} page the page object library.js passes */
export function start(page) {
  async function next() {
    const list = page.list();
    if (!list?.next) return;
    const answer = await page.net.call("GET", `/api/library?sort=${page.sort}&cursor=${encodeURIComponent(list.next)}`);
    // Every write and every changed read replaces the list: a page asked for before that belongs to a list now gone,
    // and the next intersection asks again.
    if (!answer.ok || page.list() !== list) return;
    const have = new Set(list.files.map((/** @type {{id: string}} */ f) => f.id));
    const got = /** @type {List} */ (answer.value);
    page.setList({ ...list, files: [...list.files, ...got.files.filter((f) => !have.has(f.id))], next: got.next });
  }
  return { next };
}
