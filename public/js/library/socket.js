// The library socket (docs/library.md section 4), open only while a row uploads or prepares: progress frames move the
// row's count in place; `first`, `ready`, `failed` and `quota` refetch the list. Until it is open, and whenever it
// drops, the page polls every 10 s; a blocked socket (a campus proxy) shows nothing, since nothing is wrong.
import { wsUrl } from "../core/ui.js";
import { withRow } from "./model.js";

/** Closed by the server for the user's session ending: the next fetch says so, so no reconnect. */
const SESSION_ENDED = 4001;
const RETRY_CAP_MS = 30_000;

/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @type {WebSocket | null} */
  let ws = null;
  let wanted = false;
  let retries = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @param {string} id @param {number} done @param {number} total */
  function progress(id, done, total) {
    const list = page.list();
    const row = page.row(id);
    if (!list || !row || row.derived.state !== "preparing") return;
    if (row.derived.done === done && row.derived.total === total) return;
    page.setList(withRow(list, { ...row, derived: { ...row.derived, done, total } }));
  }

  /** @param {unknown} data */
  function frame(data) {
    let f;
    try {
      f = JSON.parse(String(data));
    } catch {
      return;
    }
    if (f?.t === "hello" && Array.isArray(f.progress)) {
      for (const p of f.progress) progress(String(p?.id), Number(p?.done), Number(p?.total));
    } else if (f?.t === "progress") {
      progress(String(f.id), Number(f.done), Number(f.total));
    } else if (["first", "ready", "failed", "quota"].includes(f?.t)) {
      void page.load(true);
    }
  }

  function connect() {
    if (ws || !wanted) return;
    try {
      ws = new WebSocket(wsUrl("/api/library/ws"));
    } catch {
      page.polling(true);
      return;
    }
    const socket = ws;
    socket.onopen = () => {
      retries = 0;
      page.polling(false);
    };
    socket.onmessage = (e) => frame(e.data);
    socket.onclose = (e) => {
      if (ws === socket) ws = null;
      if (!wanted) return;
      page.polling(true);
      if (e.code === SESSION_ENDED) return void page.load(true);
      timer = setTimeout(connect, Math.min(RETRY_CAP_MS, 1000 * 2 ** retries++));
    };
  }

  /** Opens the socket while something is on its way, and closes it once nothing is. @param {boolean} on */
  function watch(on) {
    wanted = on;
    if (on) return connect();
    clearTimeout(timer);
    const socket = ws;
    ws = null;
    socket?.close(1000);
    page.polling(false);
  }

  return { watch };
}
