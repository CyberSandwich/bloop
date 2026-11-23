// The phone page (/a): claims the code from the QR, shows the room and match code, lists the items to tick,
// and approves them; once approved it shows what the screen got, the time left and Revoke. The code leaves the
// address bar first (core/boot-code.js).

/** @import {ClaimResponse, Entry, ErrorCode, Item, PhoneStateKey, PhoneView} from "../../src/shared/protocol.ts" */
import { createApi } from "./core/api.js";
import { bootCode } from "./core/boot-code.js";
import { openChannel } from "./core/channel.js";
import { phoneCopy } from "./core/copy.js";
import { thumbOf } from "./core/demo.js";
import { sendable, sendFile, wholeMB } from "./core/drop.js";
import { loadFiles } from "./core/files.js";
import { ago, countdown, ICON_ADD } from "./core/format.js";
import { rowFace, tile } from "./core/rows.js";
import { firstFile, phoneKey } from "./core/states.js";
import { PID_KEY, refOf, SID_KEY, sameScreen, sessionStore } from "./core/store.js";
import { ariaFlag, byId, el, focusTitle, ICON_CHECK, icon, isFramed, setText, show, wsUrl } from "./core/ui.js";
import { VERIFIED } from "./core/verified.js";
import { ERRORS } from "./shared/errors.js";

const api = createApi();
const store = sessionStore();

const back = byId("back");
const title = byId("title");
const skelTitle = byId("skel-title");
const body = byId("body");
const roomSub = byId("room-sub");
const matchBlock = byId("match-block");
const matchDigits = byId("match-digits");
const warn = byId("warn");
const warnText = byId("warn-text");
const filesForm = byId("files");
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
};

/** Failed calls become the state key the shared error table names; offline and generic errors can retry. */
function fail(/** @type {ErrorCode} */ code, /** @type {(() => void) | null} */ retry = null) {
  const key = ERRORS[code].phone ?? "error";
  c.error = key === "typed_wrong" ? "expired" : key;
  c.retry = key === "offline" || key === "error" ? retry : null;
  render();
}

const look = () => ({ mode: c.info?.mode ?? "live", kind: "owner" });

const tickMark = () => el("span", { class: "tick" }, [icon(ICON_CHECK, 20)]);

/** The list to tick: one checkbox row per entry, then "Add a file", the guest path for a file not in it. */
function buildRows(/** @type {Entry[]} */ entries, /** @type {boolean} */ add) {
  const demo = c.info?.mode === "demo";
  fileList.replaceChildren(
    ...entries.map((entry) => {
      const input = el("input", { type: "checkbox", value: entry.id });
      input.addEventListener("change", () => {
        const on = new Set(c.selected);
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
              el("span", { class: "row-text row-name" }, ["Add a file"]),
            ]),
          ]),
        ]
      : []),
  );
}

function buildItems(/** @type {Item[]} */ items) {
  fileList.replaceChildren(
    ...items.map((item) =>
      el("li", {}, [el("div", { class: "row is-on" }, [...rowFace(item, thumbOf(item, look())), tickMark()])]),
    ),
  );
}

function setView(/** @type {PhoneView} */ view) {
  c.view = view;
  c.skew = view.now - Date.now();
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
        const node = a.href
          ? el("a", { class: `btn ${a.kind}`, href: a.href, "data-action": a.id })
          : el("button", { class: `btn ${a.kind}`, type: "button", "data-action": a.id });
        return node;
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
    // This tab holds the sid of the demo screen it claimed: it came from /s by "Approve on This Device" and can go back.
    back: demo && sameScreen(store.get(SID_KEY), c.pid),
  });

  back.setAttribute("href", demo && sameScreen(store.get(SID_KEY), c.pid) ? "/s?mode=demo" : "/");
  show(skelTitle, key === "checking");
  show(title, key !== "checking");
  setText(title, copy.title);
  setText(body, copy.body);

  show(roomSub, copy.room && !!c.info?.registered && VERIFIED.roomRegistration);
  show(matchBlock, copy.match);
  setText(matchDigits, c.info?.match ?? "");
  show(warn, copy.warn !== "");
  setText(warnText, copy.warn);

  show(filesForm, copy.files !== "none");
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
  if (key !== c.key) {
    c.key = key;
    if (key !== "checking" && key !== "approving") focusTitle(title);
  }
}

/** "Ends in 59:12": the server's end time on the server's clock, counted down here. */
function countDown() {
  const at = c.view?.endsAt;
  if (!ends.hidden && at) setText(ends, `Ends in ${countdown(at - (Date.now() + c.skew))}`);
}

fileList.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("[data-action='send-file']")) chooseFile();
});

actionsEl.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("[data-action]") : null;
  const id = target?.getAttribute("data-action");
  if (id === "approve") approve();
  else if (id === "cancel") cancelPairing();
  else if (id === "end") endSession();
  else if (id === "done") done();
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
  const run = c.retry;
  c.error = null;
  c.retry = null;
  render();
  run?.();
}

function done() {
  store.remove(PID_KEY);
  location.assign("/");
}

async function approve() {
  if (c.selected.length === 0 || c.approving) return;
  c.approving = true;
  render();
  const res = await api.post("/api/approve", { ids: c.selected }, c.pid);
  c.approving = false;
  if (res.ok) {
    setView(res.value);
    render();
  } else fail(res.error, approve);
}

/** A phone that scanned with nothing to choose from sends its own file: the server turns the claim into a guest at the first byte. */
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

/** The server drops the pairing before it answers, so its `pairing_invalid` push arrives first: `canceling` keeps it from showing as expired. */
async function cancelPairing() {
  c.upload?.abort();
  c.canceling = true;
  const res = await api.post("/api/cancel", {}, c.pid);
  c.canceling = false;
  if (!res.ok) return fail(res.error);
  c.canceled = true;
  c.channel?.stop();
  c.channel = null;
  store.remove(PID_KEY);
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
  // A demo room approves its whole catalog as one list; a live phone starts from its newest file alone.
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
    onError: (code) => {
      if (!c.canceling && !c.canceled) fail(code);
    },
    onLink: () => {},
  });
  addEventListener("online", () => c.channel?.nudge());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) c.channel?.nudge();
  });
}

/** @param {ClaimResponse} claim */
function paired(claim) {
  store.set(PID_KEY, claim.pid);
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
    if (res.error === "offline" || res.error === "service_down") return fail("offline", () => resume(pid));
    store.remove(PID_KEY);
    return fail("pairing_invalid");
  }
  const view = /** @type {PhoneView} */ (res.value);
  c.info = { roomName: view.room.name, registered: view.room.registered, match: view.match, mode: view.mode };
  setView(view);
  c.maxBytes = view.dropMaxBytes;
  attach(pid);
  render();
  if (view.kind === "owner" && (view.state === "claimed" || view.state === "choosing")) listFiles();
}

function start() {
  if (isFramed()) {
    c.error = "framed";
    render();
    return;
  }
  render();
  setInterval(countDown, 1000);
  const pid = store.get(PID_KEY);
  if (bootCode) claim(bootCode);
  else if (pid) resume(pid);
  else fail("pairing_invalid");
}

start();
