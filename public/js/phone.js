// The phone page (/a): claims the code from the QR, shows the room and match code, lists files,
// and approves one. The code leaves the address bar first (core/boot-code.js).

/** @import {ClaimResponse, ErrorCode, FileEntry, PhoneStateKey, PhoneView} from "../../src/shared/protocol.ts" */
import { createApi } from "./core/api.js";
import { bootCode } from "./core/boot-code.js";
import { openChannel } from "./core/channel.js";
import { phoneCopy } from "./core/copy.js";
import { sendable, sendFile, wholeMB } from "./core/drop.js";
import { loadFiles } from "./core/files.js";
import { ago, clock, splitName } from "./core/format.js";
import { phoneKey } from "./core/states.js";
import { PID_KEY, sessionStore } from "./core/store.js";
import {
  ariaFlag,
  byId,
  el,
  focusTitle,
  ICON_CHECK,
  ICON_PRESENTATION,
  icon,
  isFramed,
  setText,
  show,
  wsUrl,
} from "./core/ui.js";
import { VERIFIED } from "./core/verified.js";
import { ERRORS } from "./shared/errors.js";

const api = createApi();
const store = sessionStore();

const title = byId("title");
const skelTitle = byId("skel-title");
const body = byId("body");
const awayStill = byId("away");
const roomRow = byId("room");
const roomName = byId("room-name");
const roomSub = byId("room-sub");
const matchBlock = byId("match-block");
const matchDigits = byId("match-digits");
const warn = byId("warn");
const warnText = byId("warn-text");
const filesForm = byId("files");
const fileList = byId("file-list");
const scope = byId("scope");
const scopeText = byId("scope-text");
const actionsEl = byId("actions");
const polite = byId("polite");
const filePick = /** @type {HTMLInputElement} */ (byId("file-pick"));
const barWrap = byId("bar-wrap");
const bar = /** @type {HTMLProgressElement} */ (byId("bar"));

/**
 * @type {{
 *   error: PhoneStateKey | null, info: import("./core/states.js").PhoneInfo | null, view: PhoneView | null,
 *   files: FileEntry[] | null, selected: string | null, approving: boolean, canceled: boolean,
 *   pid: string | null, channel: ReturnType<typeof openChannel> | null, retry: (() => void) | null,
 *   key: PhoneStateKey | null, rows: FileEntry[] | null, actionIds: string, account: boolean,
 *   drop: import("./core/states.js").PhoneCtx["drop"], file: File | null, maxBytes: number,
 *   upload: { abort: () => void } | null, progress: number
 * }}
 */
const c = {
  error: null,
  info: null,
  view: null,
  files: null,
  selected: null,
  approving: false,
  canceled: false,
  pid: null,
  channel: null,
  retry: null,
  key: null,
  rows: null,
  actionIds: "",
  account: false,
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

function buildRows(/** @type {FileEntry[]} */ files) {
  fileList.replaceChildren(
    ...files.map((f) => {
      const [head, tail] = splitName(f.name);
      const input = el("input", { type: "radio", name: "file", value: f.id });
      input.addEventListener("change", () => {
        c.selected = f.id;
        render();
      });
      const tick = el("span", { class: "tick" });
      tick.append(icon(ICON_CHECK, 16));
      return el("li", {}, [
        el("label", { class: "row" }, [
          input,
          icon(ICON_PRESENTATION),
          el("span", { class: "row-text" }, [
            el("span", { class: "row-name" }, [
              el("span", { class: "head" }, [head]),
              el("span", { class: "tail" }, [tail]),
            ]),
            el("span", { class: "small" }, [`Edited ${ago(Date.now(), f.modifiedAt)}`]),
          ]),
          tick,
        ]),
      ]);
    }),
  );
}

function buildSkeleton() {
  fileList.replaceChildren(...Array.from({ length: 5 }, () => el("li", { class: "skel" })));
}

/** Rebuilds the action buttons only when the set changes, so a button keeps focus while it shows progress. */
function renderActions(/** @type {import("./core/copy.js").PhoneAction[]} */ actions, /** @type {boolean} */ loading) {
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
  const picked = c.files?.find((f) => f.id === c.selected);
  const copy = phoneCopy(key, {
    room: c.info?.roomName ?? v?.room.name ?? "",
    file: c.drop ? (c.file?.name ?? null) : (v?.fileName ?? picked?.name ?? null),
    endsAt: v?.endsAt ? clock(v.endsAt) : null,
    account: c.account,
    maxMB: wholeMB(c.maxBytes),
  });

  show(skelTitle, key === "checking");
  show(title, key !== "checking");
  setText(title, copy.title);
  setText(body, copy.body);
  show(awayStill, copy.still);

  show(roomRow, copy.room);
  setText(roomName, c.info?.roomName ?? "");
  show(roomSub, copy.room && !!c.info?.registered && VERIFIED.roomRegistration);
  show(matchBlock, copy.match);
  setText(matchDigits, c.info?.match ?? "");
  show(warn, copy.warn !== "");
  setText(warnText, copy.warn);

  show(filesForm, copy.files !== "none");
  if (copy.files === "skeleton") {
    if (c.rows !== null || fileList.children.length !== 5) buildSkeleton();
    c.rows = null;
  } else if (copy.files === "list" && c.files && c.rows !== c.files) {
    buildRows(c.files);
    c.rows = c.files;
  }
  for (const input of fileList.querySelectorAll("input")) input.checked = input.value === c.selected;

  show(scope, copy.scope !== "");
  setText(scopeText, copy.scope);
  show(barWrap, copy.progress);
  bar.value = Math.round(c.progress * 100);
  renderActions(copy.actions, copy.loading);

  setText(polite, key === "approving" ? "Approving" : "");
  if (key !== c.key) {
    c.key = key;
    if (key !== "checking" && key !== "approving") focusTitle(title);
  }
}

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
  if (!c.selected || c.approving) return;
  c.approving = true;
  render();
  const res = await api.post("/api/approve", { fileId: c.selected }, c.pid);
  c.approving = false;
  if (res.ok) {
    c.view = res.value;
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
    c.view = res.view;
    render();
  } else fail(res.error, send);
}

async function cancelPairing() {
  c.upload?.abort();
  const res = await api.post("/api/cancel", {}, c.pid);
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
  c.view = res.value;
  render();
}

async function listFiles() {
  c.files = null;
  c.selected = null;
  render();
  const res = await loadFiles(api, /** @type {string} */ (c.pid));
  if (!res.ok) return fail(res.error, listFiles);
  c.files = res.files;
  c.selected = res.files[0]?.id ?? null;
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
    url: `${wsUrl("/api/pair/ws")}?ref=${pid.split(".")[0]}`,
    statePath: "/api/pair/state",
    credential: pid,
    helloKey: "pid",
    api,
    connect: (url) => new WebSocket(url),
    onView: (view) => {
      c.view = view;
      render();
    },
    onError: (code) => {
      if (!c.canceled) fail(code);
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
  c.view = view;
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
  const pid = store.get(PID_KEY);
  if (bootCode) claim(bootCode);
  else if (pid) resume(pid);
  else fail("pairing_invalid");
}

start();
