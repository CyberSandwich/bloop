// /library (docs/ux/library.md, plan section 7): the list, Up Next, quota and the panel paint from the last answer kept in
// sessionStorage, then the fetch replaces it in place. Every write is optimistic and reverts in the frame its refusal
// arrives. The rest loads by intent: each lazy module exports `start(page)` and gets the page object below.
/** @import {List, Row} from "./library/model.js" */
import {
  dateText,
  deletingLine,
  fullLine,
  isPaged,
  kindOf,
  positionText,
  quotaLine,
  quotaShare,
  sizeText,
  T,
} from "./core/copy-library.js";
import { splitName } from "./core/format.js";
import { ICONS } from "./core/icons.js";
import { loader } from "./core/loader.js";
import { sessionStore } from "./core/store.js";
import { createToaster } from "./core/toast.js";
import { ariaFlag, byId, el, focusTitle, icon, lostFocus, setText, show } from "./core/ui.js";
import { GLYPHS } from "./library/glyphs.js";
import * as M from "./library/model.js";
import { createNet } from "./library/net.js";

const MB = 1024 * 1024;
const CACHE = "bloop.library";
const CACHE_TAG = "bloop.library.etag";
const SORT_KEY = "bloop.library.sort";
const UNDO_MS = 8000;
/** "Up Next Cleared" has no trash behind it, so its Undo waits longer (plan 7.3). */
const CLEARED_MS = 30_000;
const POLL_MS = 10_000;
const SLOW_MS = 4000;

const net = createNet({ timeoutMs: 15_000 });
const store = sessionStore();
const prefs = (() => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
})();

const els = {
  body: document.body,
  title: byId("title"),
  quota: byId("quota"),
  bar: byId("bar"),
  used: byId("bar-used"),
  reserved: byId("bar-reserved"),
  note: byId("note"),
  card: byId("card"),
  cardTitle: byId("card-title"),
  cardLine: byId("card-line"),
  cardAction: /** @type {HTMLButtonElement} */ (byId("card-action")),
  empty: byId("empty"),
  up: byId("up"),
  upList: byId("up-list"),
  first: byId("first"),
  clear: byId("clear"),
  files: byId("files"),
  fileList: byId("file-list"),
  trashLink: byId("trash-link"),
  trashView: byId("trash-view"),
  back: byId("back"),
  emptyTrash: byId("empty-trash"),
  sample: byId("sample"),
  add: byId("add"),
  present: /** @type {HTMLButtonElement} */ (byId("present")),
  presentCard: /** @type {HTMLButtonElement} */ (byId("present-card")),
  polite: byId("polite"),
  pick: /** @type {HTMLInputElement} */ (byId("pick")),
};

/** @type {List | null} */
let list = M.cached(store.get(CACHE));
let etag = list ? store.get(CACHE_TAG) : null;
let offline = false;
let view = "files";
let sort = prefs?.getItem(SORT_KEY) ?? "updated";
if (!["updated", "name", "size"].includes(sort)) sort = "updated";

// ---- Toasts: core/toast.js draws them; the page times the ones with an action and pauses them under the pointer. ----
/** @type {HTMLElement | null} */
let shown = null;
const toaster = createToaster({
  createElement: (/** @type {string} */ tag) => document.createElement(tag),
  body: {
    append: (/** @type {HTMLElement} */ node) => {
      shown = node;
      document.body.append(node);
    },
  },
});
/** The one Undo that a toast offers right now; Cmd+Z runs it while that toast shows. @type {(() => void) | null} */
let undoing = null;
let undoKind = "";

/** @param {import("./core/toast.js").Toast} t */
const say = (t) => {
  undoing = null;
  toaster(t);
};

/** A toast with an action, gone after `ms` unless the pointer or focus rests on it. */
function held(/** @type {import("./core/toast.js").Toast} */ t, /** @type {number} */ ms) {
  toaster(t);
  const node = shown;
  if (!node) return;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const leave = () => {
    if (!node.isConnected) return;
    node.classList.add("out");
    setTimeout(() => node.remove(), 200);
  };
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(leave, ms);
  };
  for (const type of ["pointerenter", "focusin"]) node.addEventListener(type, () => clearTimeout(timer));
  for (const type of ["pointerleave", "focusout"]) node.addEventListener(type, run);
  run();
}

/**
 * An Undo toast: one level, so a second press does nothing.
 * @param {string} title @param {string} body @param {() => void} revert @param {number} [ms] @param {string} [kind]
 */
function undoToast(title, body, revert, ms = UNDO_MS, kind = "") {
  let once = () => {
    once = () => {};
    undoing = null;
    revert();
  };
  held({ title, body, action: { label: T.undo, run: () => once() } }, ms);
  undoing = () => once();
  undoKind = kind;
}

const reloadAction = { label: T.reload, run: () => location.reload() };
const notLoaded = () => say({ title: T.notLoaded, body: T.reloadLine, action: reloadAction, error: true });
const sayOffline = () => say({ title: T.offline, body: T.offlineBody });

// ---- Writes ---------------------------------------------------------------------------------------------------------
const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("bloop-library") : null;

/** Offline is known from a failed request: writes are refused up front, and nothing queues. */
function guard() {
  if (offline) sayOffline();
  return !offline;
}

/** A library action other than Clear's own ends the Clear's long Undo. */
function settle() {
  if (undoKind === "cleared") undoing = null;
  undoKind = "";
}

/**
 * One write. Its answer clears the offline mark; another tab is told to refetch.
 * @param {"POST" | "PATCH" | "PUT" | "DELETE"} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [extra]
 */
async function send(method, path, body, extra) {
  const answer = await net.call(method, path, body, extra);
  if (answer.ok) {
    offline = false;
    channel?.postMessage("changed");
  } else if (answer.code === "offline") {
    offline = true;
  }
  return answer;
}

/** A refused write as its toast; the row was already put back, and focus stays. @param {{code: string}} answer */
function refuse(answer) {
  if (answer.code === "offline") return sayOffline();
  if (answer.code === "auth_required") return toSignIn();
  if (answer.code === "account_deleting") return void load();
  if (answer.code === "not_found") return say({ title: T.gone, body: "" });
  if (answer.code === "up_next_full") return say({ title: T.fullTitle, body: fullLine(list?.limits.upNext ?? 0) });
  say({ title: T.notSaved, body: T.checkConnection, error: true });
}

const toSignIn = () => location.assign("/signin?next=/library");
const fileRow = (/** @type {string} */ id) => list?.files.find((f) => f.id === id) ?? null;
const path = (/** @type {string} */ id) => `/api/library/${encodeURIComponent(id)}`;

/**
 * Applies `next` at once, then sends the write; a refusal puts `list` back as it was before.
 * @param {List} next @param {"POST" | "PATCH" | "PUT"} method @param {string} url @param {unknown} body
 */
async function optimistic(next, method, url, body) {
  if (!list || !guard()) return null;
  settle();
  const before = list;
  list = next;
  render();
  const answer = await send(method, url, body);
  if (!answer.ok) {
    list = before;
    render();
    refuse(answer);
    return null;
  }
  return answer.value;
}

/** Ticks or unticks a file; the 13th stays off with its toast. @param {string} id @param {boolean} on */
async function setTick(id, on) {
  if (!list) return;
  const result = M.tick(list.upNext, id, on, list.limits.upNext);
  if (result.full) {
    render();
    return say({ title: T.fullTitle, body: fullLine(list.limits.upNext) });
  }
  const row = await optimistic(M.withOrder(list, result.order), "PATCH", path(id), { selected: on });
  if (row && list) {
    list = M.withRow(list, row);
    paint();
  }
}

/** @param {string[]} order the Up Next order to store, whole (reorder, Clear and its Undo) */
async function setOrder(order) {
  if (!list) return null;
  const answer = await optimistic(M.withOrder(list, order), "PUT", "/api/library/up-next", { ids: order });
  if (answer && list && Array.isArray(answer.upNext)) {
    list = M.withOrder(list, answer.upNext);
    paint();
  }
  return answer;
}

/** Moves an Up Next file by `delta` and says where it landed. @param {string} id @param {number} delta */
async function moveBy(id, delta) {
  if (!list) return;
  const order = M.move(list.upNext, id, delta);
  if (order === list.upNext) return;
  const row = fileRow(id);
  setText(els.polite, positionText(row?.name ?? "", order.indexOf(id) + 1, order.length));
  await setOrder(order);
}

async function clearUpNext() {
  if (!list || list.upNext.length === 0) return;
  const before = list.upNext;
  if (await setOrder([])) undoToast(T.cleared, "", () => void setOrder(before), CLEARED_MS, "cleared");
}

/** Moves a file to the trash at once, with Undo that puts it back in its Up Next place. @param {string} id */
async function trashFile(id) {
  if (!list) return;
  const at = list.upNext.indexOf(id);
  const order = list.upNext;
  const next = focusAfter(id);
  const done = await optimistic(M.withoutRow(list, id), "POST", `${path(id)}/trash`, {});
  if (!done) return;
  next?.focus();
  if (lostFocus()) focusTitle(els.title);
  /** @type {unknown[]} */
  const left = Array.isArray(done.leftScreens) ? done.leftScreens : [];
  const labels = left.filter((l) => typeof l === "string");
  undoToast(T.movedTitle, labels.length ? `It also left ${labels.join(", ")}.` : "", async () => {
    const back = await send("POST", `${path(id)}/restore`, {});
    if (!back.ok) return refuse(back);
    if (at >= 0) await send("PUT", "/api/library/up-next", { ids: order });
    await load();
  });
  void load();
}

/** The control focus goes to when a row leaves: the next row's, else the one before. @param {string} id */
function focusAfter(id) {
  const item = document.activeElement?.closest("li");
  if (!item || item.getAttribute("data-id") !== id) return null;
  const other = /** @type {HTMLElement | null} */ (item.nextElementSibling ?? item.previousElementSibling);
  return /** @type {HTMLElement | null} */ (other?.querySelector(".lib-open") ?? null);
}

/** Renames in place; the extension stays the file's. @param {string} id @param {string} base */
async function rename(id, base) {
  const row = fileRow(id);
  if (!list || !row) return false;
  const named = { ...row, name: row.ext ? `${base}.${row.ext}` : base };
  const answer = await optimistic(M.withRow(list, named), "PATCH", path(id), { name: base });
  if (answer && list) {
    list = M.withRow(list, answer);
    paint();
  }
  return !!answer;
}

/** The original as the browser's own download (a `/p/` original link, library.md section 4). @param {string} id */
async function download(id) {
  const answer = await send("POST", `${path(id)}/preview`, { asset: "original" });
  if (!answer.ok) return refuse(answer);
  const link = el("a", { href: String(answer.value.base), download: "" });
  document.body.append(link);
  link.click();
  link.remove();
}

// ---- Loading -------------------------------------------------------------------------------------------------------
/** @type {ReturnType<typeof setTimeout> | undefined} */
let slowTimer;

/** Refetches the list (conditional), and paints what changed. @param {boolean} [quiet] a refresh nobody waits for */
async function load(quiet = false) {
  const cold = !list;
  if (cold && !quiet) slowTimer ??= setTimeout(() => setText(els.note, T.slow), SLOW_MS);
  const query = `/api/library?sort=${sort}`;
  const answer = await net.call("GET", query, undefined, etag && list ? { "If-None-Match": etag } : {});
  clearTimeout(slowTimer);
  slowTimer = undefined;
  setText(els.note, "");
  if (answer.ok) {
    offline = false;
    if (answer.status !== 304) {
      list = /** @type {List} */ (answer.value);
      etag = answer.headers.get("ETag");
      store.set(CACHE, JSON.stringify(list));
      if (etag) store.set(CACHE_TAG, etag);
    }
    show(els.card, false);
    els.body.classList.remove("is-deleting");
    render();
    return;
  }
  if (answer.code === "auth_required") return toSignIn();
  if (answer.code === "account_deleting") return deleting(Number(answer.body?.deleteAfter));
  if (answer.code === "offline") {
    const was = offline;
    offline = true;
    if (list && !was) sayOffline();
  }
  if (!list && !quiet) failed();
}

/** Appends the next page of 200 when the last row comes into view. */
async function more() {
  if (!list?.next) return;
  const cursor = list.next;
  const answer = await net.call("GET", `/api/library?sort=${sort}&cursor=${encodeURIComponent(cursor)}`);
  if (!answer.ok || !list || list.next !== cursor) return;
  const have = new Set(list.files.map((f) => f.id));
  const page = /** @type {List} */ (answer.value);
  list = { ...list, files: [...list.files, ...page.files.filter((f) => !have.has(f.id))], next: page.next };
  render();
}

/** @param {string} title @param {string} line @param {string} action @param {() => void} run @param {boolean} alert */
function showCard(title, line, action, run, alert) {
  setText(els.cardTitle, title);
  setText(els.cardLine, line);
  show(els.cardLine, !!line);
  setText(els.cardAction, action);
  els.cardAction.onclick = run;
  if (alert) els.card.setAttribute("role", "alert");
  else els.card.removeAttribute("role");
  show(els.card, true);
}

function failed() {
  els.body.classList.add("is-failed");
  showCard(
    T.failedTitle,
    T.checkConnection,
    T.tryAgain,
    () => {
      els.body.classList.remove("is-failed");
      show(els.card, false);
      void load();
    },
    true,
  );
}

/** The deletion grace: only the card and Cancel Deletion (plan 7.4). @param {number} at */
function deleting(at) {
  els.body.classList.add("is-deleting");
  els.body.classList.remove("is-loading");
  showCard(
    Number.isFinite(at) ? deletingLine(at) : "",
    "",
    T.cancelDeletion,
    async () => {
      const answer = await send("POST", "/api/me/restore", {});
      if (!answer.ok) return refuse(answer);
      await load();
    },
    false,
  );
  focusTitle(els.cardTitle);
}

// ---- Painting -------------------------------------------------------------------------------------------------------
const glyph = (/** @type {string} */ name) =>
  icon(
    GLYPHS[/** @type {keyof typeof GLYPHS} */ (name)] ??
      ICONS[/** @type {keyof typeof ICONS} */ (name)] ??
      ICONS["file-text"],
  );

/** The 40 px tile: slide 1 once prepared, the kind glyph before, the loader over it while uploading. @param {Row} row */
function tile(row) {
  if (row.upload !== undefined) return el("span", { class: "thumb lib-loading" }, [loader(row.name, null)]);
  if (row.thumb && list?.switches.previews === "on")
    return el("img", { class: `thumb${isPaged(row.ext) ? " fit" : ""}`, src: row.thumb, alt: "" });
  return el("span", { class: "thumb" }, [glyph(kindOf(row.ext).glyph)]);
}

/** Line 2: kind · size · date, then the chip and its reason, or the fonts note. @param {Row} row */
function line(row) {
  const s = M.status(row);
  const parts = [];
  const rest = [];
  const words = M.rowLine(row, Date.now());
  if (words) {
    const [kind, size, date] = words.split(" · ");
    parts.push(el("span", { class: "lib-kind" }, [kind ?? ""]), el("span", { class: "lib-size" }, [size ?? ""]));
    if (date) rest.push(el("span", { class: "lib-date" }, [date]));
  }
  if (s.chip) rest.push(el("span", { class: `lib-chip ${s.tone}` }, [s.chip]));
  if (s.reason) rest.push(el("span", { class: "lib-reason" }, [s.reason]));
  if (s.fonts) rest.push(el("span", { class: "lib-fonts" }, [glyph("triangle-alert"), s.fonts]));
  if (rest.length) parts.push(el("span", { class: "lib-rest" }, rest));
  return el("span", { class: "small lib-line" }, parts);
}

/**
 * One row: the row button (preview), then the tick and More beside it, never nested (library.md section 2). Names
 * reach the DOM as text only.
 * @param {Row} row @param {"up" | "all"} where @param {number} [n] the Up Next number
 */
function rowItem(row, where, n) {
  const [head, tail] = splitName(row.name);
  const key = `${where}:${row.id}`;
  const open = el("button", { class: "row lib-open", type: "button", "data-key": `${key}:open` }, [
    ...(n ? [el("span", { class: "lib-n", "aria-hidden": "true" }, [String(n)])] : []),
    tile(row),
    el("span", { class: "row-text" }, [
      el("span", { class: "row-name" }, [el("span", { class: "head" }, [head]), el("span", { class: "tail" }, [tail])]),
      line(row),
    ]),
  ]);
  const tickSlot = M.canTick(row)
    ? el("label", { class: "lib-tick" }, [
        el("input", {
          type: "checkbox",
          "data-key": `${key}:tick`,
          "aria-label": `${T.upNextFor}${row.name}`,
          ...(row.selected ? { checked: "" } : {}),
        }),
        icon(ICONS.check),
      ])
    : el("span", { class: "lib-tick" });
  const moreButton = el(
    "button",
    {
      class: "lib-more",
      type: "button",
      "data-key": `${key}:more`,
      "aria-haspopup": "dialog",
      "aria-label": `${T.moreFor}${row.name}`,
    },
    [glyph("ellipsis")],
  );
  const parts = [open, tickSlot, moreButton];
  if (where === "up") parts.unshift(el("span", { class: "lib-grip", "aria-hidden": "true" }, [glyph("grip-vertical")]));
  const item = el("li", { class: `lib-item${row.upload !== undefined ? " is-upload" : ""}`, "data-id": row.id }, parts);
  if (row.upload !== undefined) item.setAttribute("data-upload", row.upload);
  return item;
}

/** Focus survives a repaint: the control with the same key gets it back. */
function keep(/** @type {() => void} */ paintFn) {
  const key = document.activeElement?.getAttribute("data-key");
  paintFn();
  if (!key) return;
  const again = /** @type {HTMLElement | null} */ (document.querySelector(`[data-key="${CSS.escape(key)}"]`));
  again?.focus({ preventScroll: true });
}

/** @type {IntersectionObserver | null} */
let pager = null;

function render() {
  keep(paint);
  watch();
}

function paint() {
  const loading = !list;
  els.body.classList.toggle("is-loading", loading);
  if (!list) return;
  const rows = M.allRows(list);
  const upRows = M.upNextRows(list);
  const empty = rows.length === 0;
  els.body.classList.toggle("is-empty", empty);
  els.body.classList.toggle("has-up", upRows.length > 0);

  const share = quotaShare(list.quota);
  // The trash view writes its own line there ("Trash uses 240 MB of your 5 GB.").
  if (view === "files") setText(els.quota, quotaLine(list.quota));
  els.body.classList.toggle("is-near", share >= 0.9);
  els.bar.setAttribute("aria-valuenow", String(Math.min(100, Math.round(share * 100))));
  const limit = Math.max(1, list.quota.limit);
  els.used.style.setProperty("--w", String(Math.min(1, list.quota.used / limit)));
  els.reserved.style.setProperty("--w", String(Math.min(1, share)));

  show(els.empty, empty);
  show(els.sample, empty);
  els.add.className = `btn ${empty ? "primary" : "secondary"}`;
  show(els.present, !empty);
  els.present.disabled = false;
  els.presentCard.disabled = false;

  els.upList.replaceChildren(...upRows.map((r, i) => rowItem(r, "up", i + 1)));
  show(els.clear, upRows.length > 0);
  const first = upRows[0];
  els.first.replaceChildren(...(first ? [T.opensFirst, el("strong", {}, [first.name])] : []));
  els.fileList.replaceChildren(...rows.map((r) => rowItem(r, "all")));

  const trash = list.trash.count;
  show(els.trashLink, trash > 0);
  els.trashLink.replaceChildren(`${T.trashTitle} · `, el("span", { class: "lib-num" }, [String(trash)]));

  pager?.disconnect();
  const last = els.fileList.lastElementChild;
  if (list.next && last && "IntersectionObserver" in globalThis) {
    pager = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && void more());
    pager.observe(last);
  }
}

// ---- Live updates: the socket while a row uploads or prepares, a 10 s poll when it cannot connect ------------------
/** @type {ReturnType<typeof setInterval> | undefined} */
let pollTimer;
/** @param {boolean} on */
function polling(on) {
  if (on && pollTimer === undefined) pollTimer = setInterval(() => void load(true), POLL_MS);
  if (!on) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** True while some row is on its way: an upload, a check, or a conversion. */
const busy = () => !!list && M.allRows(list).some((r) => M.pending(r) || r.derived.state === "preparing");

function watch() {
  const on = busy();
  if (!on && !loaded.socket) return polling(false);
  void need("socket").then((socket) => {
    if (socket) socket.watch(busy());
    else polling(busy());
  });
}

// ---- Lazy modules: one import() each, fetched on the first intent; a failed one falls back (library.md section 10) --
/** @typedef {{start: (page: typeof PAGE) => any}} Lazy */
// A placeholder holds each module's place until its own commit puts the module's import() there.
const inert = async () => null;
/** @type {Record<string, () => Promise<Lazy | null>>} */
const modules = {
  menu: () => import("./library/menu.js"),
  trash: () => import("./library/trash.js"),
  sort: () => import("./library/sort.js"),
  preview: inert,
  present: inert,
  socket: inert,
  reorder: inert,
  sample: inert,
};
/** @type {Record<string, Promise<any> | undefined>} */
const loaded = {};
/** The started module, or null when it did not load (the caller falls back). @param {string} name @returns {Promise<any>} */
function need(name) {
  const fetchModule = modules[name];
  if (!fetchModule) return Promise.resolve(null);
  loaded[name] ??= fetchModule()
    .then((m) => (m ? m.start(PAGE) : null))
    .catch(() => {
      loaded[name] = undefined;
      return null;
    });
  return loaded[name];
}

/** A row's menu, or the rename field straight away (F2). @param {string} id @param {HTMLElement | null} opener @param {"menu" | "rename"} [mode] */
async function openMenu(id, opener, mode = "menu") {
  const menu = await need("menu");
  if (menu) menu.open(id, opener, mode);
  else notLoaded();
}

/** The lazy sheets' stylesheet, once; a failed load leaves the sheet unstyled and tries again next time. */
let sheetsCss = /** @type {Promise<void> | null} */ (null);
const sheetStyles = () =>
  (sheetsCss ??= new Promise((done) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/css/library-sheets.css" });
    link.onload = () => done();
    link.onerror = () => {
      link.remove();
      sheetsCss = null;
      done();
    };
    document.head.append(link);
  }));

/**
 * A modal sheet (a `<dialog>`): Escape, Close and the backdrop close it, and focus returns to its opener (plan 7.3).
 * @param {string} labelledBy @param {(Node)[]} parts @param {HTMLElement | null} opener @param {string} [cls]
 */
async function sheet(labelledBy, parts, opener, cls = "") {
  await sheetStyles();
  const dialog = el("dialog", { class: `lib-sheet ${cls}`.trim(), "aria-labelledby": labelledBy }, parts);
  dialog.addEventListener("click", (e) => {
    // The backdrop's click lands on the dialog itself, outside its box; the box's own padding is not the backdrop.
    const box = dialog.getBoundingClientRect();
    const outside = e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
    if ((e.target === dialog && outside) || /** @type {Element} */ (e.target).closest("[data-close]")) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
    else if (lostFocus()) focusTitle(els.title);
  });
  document.body.append(dialog);
  dialog.showModal();
  const title = /** @type {HTMLElement | null} */ (dialog.querySelector("[tabindex='-1']"));
  if (title) focusTitle(title);
  return dialog;
}

/** A sheet's Close: the quiet x. */
const closer = () =>
  el("button", { class: "lib-x", type: "button", "aria-label": "Close", "data-close": "" }, [glyph("x")]);

// ---- Uploads: U's pill, by intent ----------------------------------------------------------------------------------
/** @type {Promise<{add: (files: Iterable<File>) => unknown} | null> | null} */
let pill = null;
function uploads() {
  if (!list) return Promise.resolve(null);
  const maxMB = Math.floor(list.limits.maxFileBytes / MB);
  // @ts-expect-error transitional: U: core/upload-pill.js lands with U's client (ci/u-client); until then this import fails and the toast below is the fallback
  pill ??= import("./core/upload-pill.js")
    .then((/** @type {any} */ m) =>
      m.mountUploads({ kind: "library", maxMB, upNext: (/** @type {string} */ id) => setTick(id, true) }),
    )
    .catch(() => {
      pill = null;
      say({ title: T.uploadNotLoaded, body: T.reloadLine, action: reloadAction, error: true });
      return null;
    });
  return pill;
}

/** Add Files explains a paused switch or a full library instead of opening the picker (library.md section 7). */
function canAdd() {
  if (!list) return false;
  if (list.switches.uploads !== "on") {
    say({ title: T.paused, body: T.pausedBody });
    return false;
  }
  if (quotaShare(list.quota) >= 1) {
    say({ title: T.noSpace, body: T.noSpaceBody, error: true });
    return false;
  }
  return guard();
}

/** @param {Iterable<File>} files */
async function addFiles(files) {
  const chosen = [...files];
  if (chosen.length === 0) return;
  const up = await uploads();
  if (!up) return;
  up.add(chosen);
  setTimeout(() => void load(true), 1500);
}

// ---- Events ----------------------------------------------------------------------------------------------------------
/** The row id and part a control belongs to. @param {EventTarget | null} target */
function partOf(target) {
  const node = /** @type {Element | null} */ (target instanceof Element ? target : null);
  const item = node?.closest("li[data-id]");
  if (!item) return null;
  const id = item.getAttribute("data-id") ?? "";
  const part = node?.closest(".lib-open")
    ? "open"
    : node?.closest(".lib-more")
      ? "more"
      : node?.closest(".lib-grip")
        ? "grip"
        : "";
  return { id, part, item, up: !!item.closest("#up-list"), upload: item.getAttribute("data-upload") };
}

/** The intent that fetches a module: pointerdown, or focus for the buttons that name one. @param {Event} e */
function intent(e) {
  const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
  if (!t) return;
  const at = partOf(t);
  if (at?.part === "more") void need("menu");
  if (at?.part === "open" && e.type === "pointerdown") void need("preview").then((p) => p?.prefetch(at.id));
  if (at?.part === "grip" && e.type === "pointerdown")
    void need("reorder").then((r) => r?.grab(/** @type {PointerEvent} */ (e), at.id));
  if (t.closest("#sort")) void need("sort");
  if (t.closest("#present, #present-card")) void need("present");
  if (t.closest("#add, #sample")) void uploads();
  if (t.closest("#sample")) void need("sample");
}
const main = byId("main");
main.addEventListener("pointerdown", intent);
main.addEventListener("focusin", intent);

main.addEventListener("change", (e) => {
  const box = /** @type {HTMLInputElement} */ (e.target);
  const at = partOf(box);
  if (box.type === "checkbox" && at) void setTick(at.id, box.checked);
});

main.addEventListener("click", async (e) => {
  const at = partOf(e.target);
  if (!at) return;
  const opener = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest("button"));
  if (at.part === "more") await openMenu(at.id, opener);
  if (at.part === "open" && !at.upload) {
    const row = fileRow(at.id);
    if (!row || M.pending(row)) return;
    const preview = await need("preview");
    if (preview) preview.open(at.id, opener);
    else if (!row.disabled) void download(at.id);
  }
});

main.addEventListener("keydown", (e) => {
  const at = partOf(e.target);
  if (at?.part !== "open" || at.upload) return;
  const row = fileRow(at.id);
  if (!row) return;
  if (e.key === " ") {
    e.preventDefault();
    if (M.canTick(row)) void setTick(row.id, !row.selected);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    void trashFile(row.id);
  } else if (e.key === "F2") {
    e.preventDefault();
    void openMenu(row.id, /** @type {HTMLElement} */ (e.target), "rename");
  } else if (at.up && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    void moveBy(row.id, e.key === "ArrowUp" ? -1 : 1);
  }
});

addEventListener("keydown", (e) => {
  if (!(e.key === "z" || e.key === "Z") || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
  if (/** @type {Element} */ (e.target).closest?.("input, textarea")) return;
  if (undoing && shown?.isConnected) {
    e.preventDefault();
    undoing();
  }
});

els.clear.addEventListener("click", () => void clearUpNext());
els.add.addEventListener("click", () => {
  if (canAdd()) els.pick.click();
});
els.pick.addEventListener("change", () => {
  void addFiles(els.pick.files ?? []);
  els.pick.value = "";
});
els.sample.addEventListener("click", async () => {
  if (!guard()) return;
  const sample = await need("sample");
  if (sample) sample.add();
  else notLoaded();
});
for (const button of [els.present, els.presentCard]) {
  button.addEventListener("click", async () => {
    const present = await need("present");
    // A failed sheet makes Present the way to /code, whose page says the same thing (present-live.md section 2).
    if (present) present.open(button);
    else location.assign("/code");
  });
}
byId("sort").addEventListener("click", async (e) => {
  const sorter = await need("sort");
  if (sorter) sorter.open(e.currentTarget);
  else notLoaded();
});
els.trashLink.addEventListener("click", async () => {
  const trash = await need("trash");
  if (trash) trash.open();
  else notLoaded();
});

// Files dropped or pasted on the page join the uploads; a folder is refused (library.md section 3).
/** @param {DataTransfer | null} data */
const hasFolder = (data) =>
  [...(data?.items ?? [])].some((item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory);
const hasFiles = (/** @type {DragEvent} */ e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
  addEventListener(type, (event) => {
    const e = /** @type {DragEvent} */ (event);
    if (!hasFiles(e)) return;
    e.preventDefault();
    const take = !!list && view === "files" && !els.body.classList.contains("is-deleting");
    if (e.type === "drop" && take) {
      if (hasFolder(e.dataTransfer)) say({ title: T.folders, body: T.foldersBody, error: true });
      else if (canAdd()) void addFiles(e.dataTransfer?.files ?? []);
    }
    void import("./core/drag.js").then((m) => m.hint(e.type, take)).catch(() => {});
  });
}
addEventListener("paste", (e) => {
  const files = e.clipboardData?.files;
  if (!files?.length || view !== "files" || /** @type {Element} */ (e.target).closest?.("input")) return;
  e.preventDefault();
  if (canAdd()) void addFiles(files);
});

addEventListener("online", () => void load(true));
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void load(true));
if (channel) channel.onmessage = () => void load(true);
addEventListener("pageshow", (e) => e.persisted && void load(true));

/** What a lazy module may use: the state, the writes, the parts they share. */
const PAGE = {
  els,
  net,
  list: () => list,
  row: fileRow,
  setList: (/** @type {List} */ next) => {
    list = next;
    render();
  },
  get view() {
    return view;
  },
  set view(v) {
    view = v;
    els.body.classList.toggle("is-trash", v === "trash");
  },
  get sort() {
    return sort;
  },
  set sort(v) {
    sort = v;
    prefs?.setItem(SORT_KEY, v);
  },
  load,
  render,
  polling,
  say,
  undoToast,
  refuse,
  guard,
  send,
  sheet,
  closer,
  glyph,
  tile,
  rowItem,
  setTick,
  moveBy,
  setOrder,
  trashFile,
  rename,
  download,
  notLoaded,
  openMenu,
  path,
  polite: (/** @type {string} */ text) => setText(els.polite, text),
  dateText,
  sizeText,
  ariaFlag,
};

if (list) render();
void load();
