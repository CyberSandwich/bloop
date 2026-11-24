// The phone page (/a): claims the QR's code (it leaves the address bar first, core/boot-code.js), lists the items to
// select and approves them with the match digits on the button; then the items, the time left and Revoke.

/** @import {ClaimResponse, Entry, ErrorCode, Item, PhoneStateKey, PhoneView} from "../../src/shared/protocol.ts" */
import { createApi } from "./core/api.js";
import { bootCode } from "./core/boot-code.js";
import { openChannel, refusal } from "./core/channel.js";
import { phoneCopy } from "./core/copy.js";
import { thumbOf } from "./core/demo.js";
import { sendable, sendFile, wholeMB } from "./core/drop.js";
import { loadFiles } from "./core/files.js";
import { ago, countdown, ICON_ADD } from "./core/format.js";
import { rowFace, tile } from "./core/rows.js";
import { adopt, firstFile, leave, liveClaim, onRefusal, phoneKey, retryStep } from "./core/states.js";
import { dropPid, PID_KEY, pidStore, refOf, SID_KEY, sameScreen, sessionStore } from "./core/store.js";
import {
  ariaFlag,
  byId,
  el,
  focusTitle,
  ICON_CHECK,
  icon,
  isFramed,
  reloadOnRestore,
  setText,
  show,
  wsUrl,
} from "./core/ui.js";
import { VERIFIED } from "./core/verified.js";
import { ERRORS } from "./shared/errors.js";
import { IN_SESSION, LIVE_CLAIM, orderItems } from "./shared/session.js";

const api = createApi();
const store = sessionStore();
const pids = pidStore();
/** The page opened with no code and no pairing: someone typed /a. */
let nocode = false;
const EXITS = ["done", "code", "end"];
const drop = (/** @type {string | null} */ pid) => dropPid(pids, pid);
const io = { post: api.post, drop, assign: (/** @type {string} */ to) => location.assign(to) };
/** Add a File from the list opened this offer: its Cancel goes back to the list. */
const fromList = () => !!c.files && (c.drop === "choose" || c.drop === "confirm");

const back = byId("back");
const title = byId("title");
const skelTitle = byId("skel-title");
const body = byId("body");
const roomSub = byId("room-sub");
const warn = byId("warn");
const warnText = byId("warn-text");
const fileList = byId("file-list");
const scope = byId("scope");
const ends = byId("ends");
const actionsEl = byId("actions");
const polite = byId("polite");
const filePick = /** @type {HTMLInputElement} */ (byId("file-pick"));
const barWrap = byId("bar-wrap");
const bar = /** @type {HTMLProgressElement} */ (byId("bar"));

/** @type {import("./types.js").PhonePage} */
const c = {
  error: null,
  info: null,
  view: null,
  files: null,
  selected: [],
  approving: false,
  canceling: false,
  canceled: false,
  pid: null,
  channel: null,
  retry: null,
  key: null,
  rows: "",
  source: null,
  actionIds: "",
  account: false,
  skew: 0,
  drop: null,
  file: null,
  maxBytes: 0,
  upload: null,
  progress: 0,
  leaving: false,
};

/** Failed calls become the state key the shared error table names; offline and generic errors can retry. */
function fail(/** @type {ErrorCode} */ code, /** @type {(() => void) | null} */ retry = null) {
  const key = ERRORS[code].phone ?? "error";
  c.error = key === "typed_wrong" ? "expired" : key;
  c.retry = key === "offline" || key === "error" ? retry : null;
  render();
}

const look = () => ({ mode: c.info?.mode ?? "live", kind: "owner" });

const tickMark = () => el("span", { class: "tick" }, [icon(ICON_CHECK)]);

/** Demo: any items; live: one file (radios), as a live screen shows one. */
function buildRows(/** @type {Entry[]} */ all, /** @type {boolean} */ add) {
  const demo = c.info?.mode === "demo";
  const entries = /** @type {Entry[]} */ (orderItems(demo ? all : all.filter((e) => e.kind === "file")));
  fileList.replaceChildren(
    ...entries.map((entry) => {
      const input = el("input", { type: demo ? "checkbox" : "radio", name: "item", value: entry.id });
      input.addEventListener("change", () => {
        const on = new Set(demo ? c.selected : []);
        if (input.checked) on.add(entry.id);
        else on.delete(entry.id);
        c.selected = entries.filter((e) => on.has(e.id)).map((e) => e.id);
        render();
      });
      // A demo entry's date is made up by the catalog, so it shows none (design.md section 6).
      const date = entry.kind === "file" && !demo ? `Edited ${ago(Date.now(), entry.modifiedAt)}` : null;
      return el("li", {}, [
        el("label", { class: "row" }, [input, ...rowFace(entry, thumbOf(entry, look()), date), tickMark()]),
      ]);
    }),
    ...(add
      ? [
          el("li", {}, [
            el("button", { type: "button", class: "row", "data-action": "send-file" }, [
              tile(ICON_ADD),
              el("span", { class: "row-text row-name" }, ["Add a File"]),
            ]),
          ]),
        ]
      : []),
  );
}

function buildItems(/** @type {Item[]} */ items) {
  fileList.replaceChildren(
    ...items.map((item) => el("li", {}, [el("div", { class: "row" }, rowFace(item, thumbOf(item, look())))])),
  );
}

function setView(/** @type {PhoneView} */ view, pid = c.pid) {
  adopt(c, view, drop, pid);
}

function buildSkeleton() {
  fileList.replaceChildren(...Array.from({ length: 5 }, () => el("li", { class: "skel" })));
}

/** Rebuilds the action buttons only when the set changes, so a button keeps focus while it shows progress. */
function renderActions(/** @type {import("./types.js").PhoneAction[]} */ actions, /** @type {boolean} */ loading) {
  const ids = actions.map((a) => a.id).join();
  if (ids !== c.actionIds) {
    c.actionIds = ids;
    actionsEl.replaceChildren(
      ...actions.map((a) => {
        const attrs = { class: `btn ${a.kind}`, "data-action": a.id, ...(a.aria ? { "aria-label": a.aria } : {}) };
        return a.href ? el("a", { ...attrs, href: a.href }) : el("button", { ...attrs, type: "button" });
      }),
    );
  }
  for (const [i, a] of actions.entries()) {
    const node = actionsEl.children[i];
    if (!node) continue;
    const busy = loading && a.id === "approve";
    node.replaceChildren(...(busy ? [el("span", { class: "spinner", "aria-hidden": "true" }), a.label] : [a.label]));
    if (node instanceof HTMLButtonElement) node.disabled = loading;
    ariaFlag(node, "aria-busy", busy);
  }
}

function render() {
  const key = phoneKey(c);
  const v = c.view;
  const demo = c.info?.mode === "demo";
  const copy = phoneCopy(key, {
    room: c.info?.roomName ?? v?.room.name ?? "",
    file: c.drop ? (c.file?.name ?? null) : (firstFile(v?.items ?? [])?.name ?? null),
    account: c.account,
    demo,
    maxMB: wholeMB(c.maxBytes),
    match: c.info?.match ?? null,
    back: home(),
    nocode,
    live: !!v && IN_SESSION.includes(v.state),
    revoking: c.retry === endSession,
    list: fromList(),
  });

  back.setAttribute("href", home() ? "/s?mode=demo" : "/");
  // One way out: a result has Done, a dead code Enter the Code, a session Revoke. A typed /a was never a code.
  const exit = copy.actions.some((a) => EXITS.includes(a.id));
  show(back, nocode || !exit);
  show(skelTitle, key === "checking");
  show(title, key !== "checking");
  setText(title, copy.title);
  setText(body, copy.body);

  show(roomSub, copy.room && !!c.info?.registered && VERIFIED.roomRegistration);
  show(warn, copy.warn !== "");
  setText(warnText, copy.warn);

  show(fileList, copy.files !== "none");
  const source = copy.files === "list" ? c.files : copy.files === "items" ? (v?.items ?? null) : null;
  const rows = `${copy.files}:${copy.add}`;
  if (copy.files === "skeleton" && c.rows !== rows) buildSkeleton();
  else if (source && (c.rows !== rows || c.source !== source)) {
    if (copy.files === "list") buildRows(/** @type {Entry[]} */ (source), copy.add);
    else buildItems(source);
    c.source = source;
  }
  c.rows = rows;
  for (const input of fileList.querySelectorAll("input")) input.checked = c.selected.includes(input.value);

  show(scope, copy.scope !== "");
  setText(scope, copy.scope);
  show(ends, copy.ends && !!v?.endsAt);
  countDown();
  show(barWrap, copy.progress);
  bar.value = Math.round(c.progress * 100);
  renderActions(copy.actions, copy.loading);

  setText(polite, key === "approving" ? "Approving" : "");
  // A dead end (Done or Enter the Code, no list) centers as one group; a session with Revoke alone does not.
  document.body.classList.toggle(
    "is-ended",
    copy.files === "none" && copy.actions.some((a) => a.id === "done" || a.id === "code"),
  );
  if (key !== c.key) {
    c.key = key;
    if (key !== "checking" && key !== "approving") focusTitle(title);
  }
}

/** This tab is also the demo screen it claimed (the one-device round trip): its way back is that screen. */
const home = () => c.info?.mode === "demo" && sameScreen(store.get(SID_KEY), c.pid);

const SOON_MS = 300_000;
let offline = false;

/** "Ends in 59:12": the server's end time on the server's clock, counted down here. */
function countDown() {
  const at = c.view?.endsAt;
  if (ends.hidden || !at) return;
  const left = at - (Date.now() + c.skew);
  setText(ends, `Ends in ${countdown(left)}${offline ? " · Reconnecting" : ""}`);
  ends.classList.toggle("soon", left <= SOON_MS);
}

// Otherwise Back is a plain link (a modified click opens a tab) that keeps the pid.
back.addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !liveClaim(c)) return;
  e.preventDefault();
  void leave(c, io, back.getAttribute("href") ?? "/");
});

fileList.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("[data-action='send-file']")) chooseFile();
});

actionsEl.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("[data-action]") : null;
  const id = target?.getAttribute("data-action");
  if (id === "approve") approve();
  else if (id === "cancel") cancel();
  else if (id === "end") endSession();
  else if (id === "done") void leave(c, io, "/", true);
  else if (id === "retry") retry();
  else if (id === "connect") location.assign("/auth/start");
  else if (id === "disconnect") disconnect();
  else if (id === "send-file") chooseFile();
  else if (id === "pick") pickFile();
  else if (id === "send") send();
});

filePick.addEventListener("change", () => {
  const file = filePick.files?.[0];
  if (!file) return;
  c.file = file;
  if (sendable(file, c.maxBytes)) {
    c.drop = "confirm";
    render();
  } else fail("bad_type");
});

function retry() {
  const run = retryStep(c);
  render();
  run?.();
}

async function approve() {
  if (c.selected.length === 0 || c.approving) return;
  c.approving = true;
  render();
  const res = await api.post("/api/approve", { ids: c.selected }, c.pid);
  c.approving = false;
  if (!res.ok) return fail(res.error, approve);
  if (home()) return location.assign("/s?mode=demo");
  setView(res.value);
  render();
}

/** The server turns the claim into a guest at the first byte. */
function chooseFile() {
  c.drop = "choose";
  render();
}

/** The file picker needs this click as its user gesture. */
function pickFile() {
  c.error = null;
  c.retry = null;
  c.drop = "choose";
  filePick.value = "";
  render();
  filePick.click();
}

async function send() {
  const file = c.file;
  if (!file || c.drop === "sending") return;
  let stopped = false;
  c.drop = "sending";
  c.progress = 0;
  render();
  const up = sendFile({
    file,
    pid: /** @type {string} */ (c.pid),
    onProgress: (fraction) => {
      c.progress = fraction;
      render();
    },
  });
  c.upload = {
    abort: () => {
      stopped = true;
      up.abort();
    },
  };
  const res = await up.done;
  c.upload = null;
  if (stopped) return;
  c.drop = null;
  if (res.ok) {
    setView(res.view);
    render();
  } else fail(res.error, send);
}

/** From the list's offer (or the file it refused), Cancel goes back to the list: Back stays the one way out. */
function cancel() {
  if (!fromList()) return void cancelPairing();
  c.drop = null;
  c.file = null;
  c.error = null;
  render();
}

/** `canceling` keeps the server's own `pairing_invalid` push, which arrives first, from showing as expired. */
async function cancelPairing() {
  c.upload?.abort();
  c.canceling = true;
  const res = await api.post("/api/cancel", {}, c.pid);
  c.canceling = false;
  if (!res.ok) return fail(res.error);
  c.canceled = true;
  c.channel?.stop();
  c.channel = null;
  drop(c.pid);
  render();
}

async function endSession() {
  const res = await api.post("/api/end", {}, c.pid);
  if (!res.ok) return fail(res.error, endSession);
  setView(res.value);
  render();
}

async function listFiles() {
  c.files = null;
  c.selected = [];
  render();
  const res = await loadFiles(api, /** @type {string} */ (c.pid));
  if (!res.ok) return fail(res.error, listFiles);
  c.files = res.files;
  c.selected = (c.info?.mode === "demo" ? res.files : res.files.slice(0, 1)).map((e) => e.id);
  render();
  c.account = c.info?.mode === "live" && (await signedInToOneDrive());
  render();
}

/** Only the Graph source has an account to disconnect; the mock and demo sources answer `source: mock`. */
async function signedInToOneDrive() {
  const res = await api.get("/api/me");
  return res.ok && res.value?.source === "graph" && res.value?.signedIn === true;
}

async function disconnect() {
  const res = await api.post("/api/me/disconnect", {});
  if (!res.ok) return fail(res.error, disconnect);
  c.account = false;
  listFiles();
}

/** Follows the pairing live; a pushed error ends it (cancel elsewhere, Start Over, timeout). */
function attach(/** @type {string} */ pid) {
  c.pid = pid;
  c.channel = openChannel({
    url: `${wsUrl("/api/pair/ws")}?ref=${refOf(pid)}`,
    statePath: "/api/pair/state",
    credential: pid,
    helloKey: "pid",
    api,
    connect: (url) => new WebSocket(url),
    onView: (view) => {
      setView(view);
      render();
    },
    onError: (code) => onRefusal(c, code, { drop: () => drop(pid), stop: () => c.channel?.stop(), fail }),
    onLink: (link) => {
      offline = link !== "ok";
      countDown();
    },
  });
  addEventListener("online", () => c.channel?.nudge());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) c.channel?.wake();
  });
}

/** @param {ClaimResponse} claim */
function paired(claim) {
  pids.set(PID_KEY, claim.pid);
  c.info = { roomName: claim.room.name, registered: claim.room.registered, match: claim.match, mode: claim.mode };
  c.maxBytes = claim.dropMaxBytes;
  attach(claim.pid);
  if (claim.kind === "guest") {
    c.drop = "choose";
    return render();
  }
  render();
  listFiles();
}

async function claim(/** @type {string} */ code) {
  const res = await api.post("/api/claim", { code });
  if (!res.ok) return fail(res.error, () => claim(code));
  paired(res.value);
}

async function resume(/** @type {string} */ pid) {
  const res = await api.get("/api/pair/state", pid);
  if (!res.ok) {
    const kind = refusal(res.error);
    if (kind !== "dead") return fail(kind === "offline" ? "offline" : res.error, () => resume(pid));
    drop(pid);
    // A dead pid reads as no pairing ("Scan the Code").
    nocode = true;
    return fail("pairing_invalid");
  }
  const view = /** @type {PhoneView} */ (res.value);
  c.info = { roomName: view.room.name, registered: view.room.registered, match: view.match, mode: view.mode };
  setView(view, pid);
  c.maxBytes = view.dropMaxBytes;
  attach(pid);
  render();
  if (view.kind === "owner" && LIVE_CLAIM.includes(view.state)) listFiles();
}

function start() {
  if (isFramed()) {
    c.error = "framed";
    render();
    return;
  }
  render();
  reloadOnRestore();
  setInterval(countDown, 1000);
  const pid = pids.get(PID_KEY);
  if (bootCode) claim(bootCode);
  else if (pid) resume(pid);
  else {
    nocode = true;
    fail("pairing_invalid");
  }
}

start();
