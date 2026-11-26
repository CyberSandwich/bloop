// The phone page (/a): claims the QR's code (it leaves the address bar first, core/boot-code.js); live, picks the
// screen's number (core/match.js); lists the items to select and approves them (a demo's match digits on the
// button); then the items, the time left and Revoke.

/** @import {ClaimResponse, Entry, ErrorCode, Item, PhoneStateKey, PhoneView} from "../../src/shared/protocol.ts" */
import { createApi } from "./core/api.js";
import { bootCode, KEPT, takeClaim } from "./core/boot-code.js";
import { openChannel, refusal } from "./core/channel.js";
import { MAIL_SUBJECT, phoneCopy, REFUSED, refusedLine, uploadLine } from "./core/copy-phone.js";
import { thumbOf } from "./core/demo.js";
import { fileProblem, kindOf, wholeMB } from "./core/drop.js";
import { loadFiles } from "./core/files.js";
import { ago, countdown } from "./core/format.js";
import { ICONS } from "./core/icons.js";
import { loader, setProgress } from "./core/loader.js";
import { linkRow, rowFace, tile } from "./core/rows.js";
import { adopt, firstFile, leave, liveClaim, onRefusal, phoneKey, retryStep } from "./core/states.js";
import { dropPid, PID_KEY, pidStore, refOf, SID_KEY, sameScreen, sessionStore } from "./core/store.js";
import { toast } from "./core/toast.js";
import { ariaFlag, byId, el, focusTitle, icon, isFramed, reloadOnRestore, setText, show, wsUrl } from "./core/ui.js";
import { VERIFIED } from "./core/verified.js";
import { ERRORS } from "./shared/errors.js";
import { typeOfName } from "./shared/names.js";
import { IN_SESSION, LIVE_CLAIM, orderItems } from "./shared/session.js";

const api = createApi();
const store = sessionStore();
const pids = pidStore();
/** The page opened with no code and no pairing: someone typed /a. */
let nocode = false;
const EXITS = ["done", "code", "end"];
const drop = (/** @type {string | null} */ pid) => dropPid(pids, pid);
const io = { post: api.post, drop, assign: (/** @type {string} */ to) => location.assign(to) };
/** A file offered or refused on top of a list (the guest's own landing counts as one): Cancel and Back return to it. */
const fromList = () => !!c.files && (c.drop === "confirm" || c.error === "guest_refused");
/** The offer pushed a history entry, so the browser's Back returns to the list as Cancel does. */
let pushed = false;
let forgetting = false;
/** The state offers a file picker (so a dropped file is welcome too). */
let canAdd = false;

const back = byId("back");
const title = byId("title");
const skelTitle = byId("skel-title");
const body = byId("body");
const fileName = byId("file-name");
const roomSub = byId("room-sub");
const warn = byId("warn");
const warnText = byId("warn-text");
const fileList = byId("file-list");
const scope = byId("scope");
const ends = byId("ends");
const endsText = byId("ends-text");
const actionsEl = byId("actions");
const polite = byId("polite");
const filePick = /** @type {HTMLInputElement} */ (byId("file-pick"));
const revokeAsk = /** @type {HTMLDialogElement} */ (byId("revoke"));
const pickEl = byId("pick");
/** The match pick's module (core/match.js), asked for once. */
let picker = false;
let listing = false;
/** @type {((on: boolean) => void) | null} */
let remote = null;
let remoteAsked = false;
let remoteLost = false;
let reloadTapped = false;
// One object, so a view while it shows changes nothing (core/toast.js); another toast in its place gives way to it.
const RELOAD = {
  title: "Remote Didn't Load",
  body: "Reload to try again.",
  error: true,
  action: { label: "Reload", run: () => location.reload() },
  tappedAway: () => (reloadTapped = true),
};
/** Where the remote would show, until a tap dismisses it; the next view brings it back after another toast. */
const remoteFailed = () => remoteLost && !reloadTapped && remoteOn() && toast(RELOAD);

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
  progress: null,
  leaving: false,
  fault: null,
  words: null,
};

/** Failed calls become the state key the shared error table names; offline and generic errors can retry. */
function fail(/** @type {ErrorCode} */ code, /** @type {(() => void) | null} */ retry = null) {
  const key = ERRORS[code].phone ?? "error";
  c.error = key === "typed_wrong" ? "expired" : key;
  c.fault = code;
  c.retry = ["offline", "error", "service_down", "network_blocked"].includes(key) ? retry : null;
  render();
}

const look = () => ({ mode: c.info?.mode ?? "live", kind: c.info?.kind ?? "owner" });

const tickMark = () => el("span", { class: "tick" }, [icon(ICONS.check)]);

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
              tile(ICONS.plus),
              el("span", { class: "row-text row-name" }, ["Add a File"]),
            ]),
          ]),
        ]
      : []),
  );
}

/** With the remote, a file's row is a button that puts it on the screen. */
function buildItems(/** @type {Item[]} */ items) {
  const had = document.activeElement?.getAttribute("data-id");
  fileList.replaceChildren(
    ...items.map((item) => {
      const face = rowFace(item, thumbOf(item, look()));
      // A link opens here, in a new tab: never a `shown` command (LINK-01), never marked as on the screen. With the
      // remote, its tap asks the screen to open it instead (LINK-02, core/link-ask.js).
      if (item.kind === "link") return el("li", { "data-link": item.id }, [linkRow(item.url, "row", face)]);
      const tap = remote && item.kind === "file";
      /** @type {Record<string, string>} */
      const attrs = tap ? { type: "button", class: "row", "data-id": item.id } : { class: "row" };
      return el("li", {}, [el(tap ? "button" : "div", attrs, face)]);
    }),
  );
  if (had) /** @type {HTMLElement | null} */ (fileList.querySelector(`[data-id="${had}"]`))?.focus();
}

function setView(/** @type {PhoneView} */ view, pid = c.pid) {
  adopt(c, view, drop, pid);
  render();
  remoteFailed();
}

function buildSkeleton() {
  fileList.replaceChildren(...Array.from({ length: 5 }, () => el("li", { class: "skel" })));
}

/** The one file on its way: its row over the loader (design.md section 6), whose fill grows with the bytes sent. */
function buildUpload() {
  const name = c.file?.name ?? "Your file";
  // A HEIC goes as the JPEG made of it.
  const item = /** @type {Item} */ ({
    kind: "file",
    id: "",
    name,
    type: typeOfName(name) ?? "jpg",
    size: c.file?.size ?? null,
  });
  const part = loader(name, null);
  part.setAttribute("aria-label", `Sending ${name}`);
  const [face, ...text] = rowFace(item, null);
  // After a reload this page holds no file, so no type to draw: an empty tile.
  const lead = c.file && face ? face : el("span", { class: "thumb" });
  fileList.replaceChildren(el("li", {}, [el("div", { class: "row upload" }, [part, lead, ...text])]));
}

function showUpload() {
  const part = fileList.querySelector(".loader");
  if (part instanceof HTMLElement) setProgress(part, c.progress);
  setText(
    /** @type {HTMLElement} */ (fileList.querySelector(".small")),
    uploadLine(c.progress, c.file && kindOf(c.file.name)),
  );
}

/** The send (core/send.js): asked for when the offer shows, so it is in before Send; a failed load asks again. */
let sender = /** @type {Promise<typeof import("./core/send.js")> | null} */ (null);
const loadSend = () =>
  (sender ??= import("./core/send.js").catch((e) => {
    sender = null;
    throw e;
  }));

/** Rebuilds the action buttons only when the set changes, so a button keeps focus while it shows progress. */
function renderActions(/** @type {import("./types.js").PhoneAction[]} */ actions, /** @type {boolean} */ loading) {
  const ids = actions.map((a) => a.id).join();
  if (ids !== c.actionIds) {
    c.actionIds = ids;
    actionsEl.replaceChildren(
      ...actions.map((a) => {
        const attrs = {
          class: `btn ${a.kind}`,
          "data-action": a.id,
          ...(a.aria ? { "aria-label": a.aria } : {}),
          ...(a.waitlist ? { "data-waitlist": "" } : {}),
        };
        return a.href ? el("a", { ...attrs, href: a.href }) : el("button", { ...attrs, type: "button" });
      }),
    );
    // A row of none takes no gap in the panel (the pick's state has none).
    actionsEl.hidden = !actions.length;
    fillMail();
  }
  for (const [i, a] of actions.entries()) {
    const node = actionsEl.children[i];
    if (!node) continue;
    const busy = loading && a.id === "approve";
    node.replaceChildren(...(busy ? [el("span", { class: "spinner", "aria-hidden": "true" }), a.label] : [a.label]));
    if (node instanceof HTMLButtonElement) node.disabled = loading || !!a.disabled;
    ariaFlag(node, "aria-busy", busy);
  }
}

/** The chooser's keys, owner or guest: a live claim picks the screen's number before any of them. @type {PhoneStateKey[]} */
const CHOOSER = ["match", "empty", "choose", "approving", "approve", "approve_demo", "unregistered", "guest_add"];

/**
 * core/states.js's key with the live pick over it (present-live.md 3.2): here, so the room screen's first load never
 * carries the pick.
 */
const withPick = (/** @type {PhoneStateKey} */ key) =>
  c.info?.choices && !c.view?.confirmed && CHOOSER.includes(key) ? "pick" : key;

/** Where the remote shows (a demo, opening or open), and so its Reload toast. */
const remoteOn = () => c.info?.mode === "demo" && ["opening", "open"].includes(phoneKey(c));

function render() {
  const key = withPick(phoneKey(c));
  const v = c.view;
  const demo = c.info?.mode === "demo";
  const copy =
    c.words?.(key) ??
    phoneCopy(key, {
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

  canAdd = copy.add || key === "guest_confirm" || copy.actions.some((a) => a.id === "send-file" || a.id === "pick");
  back.setAttribute("href", home() ? "/s?mode=demo" : "/");
  // One way out: a result has Done, a dead code Enter the Code, a session Revoke. A typed /a was never a code.
  const exit = copy.actions.some((a) => EXITS.includes(a.id));
  show(back, nocode || !exit);
  show(skelTitle, key === "checking");
  show(title, key !== "checking");
  setText(title, copy.title);
  show(fileName, copy.name !== "");
  setText(fileName, copy.name);
  setText(body, copy.body);

  show(roomSub, copy.room && !!c.info?.registered && VERIFIED.roomRegistration);
  show(warn, copy.warn !== "");
  setText(warnText, copy.warn);

  show(fileList, copy.files !== "none");
  const source = copy.files === "list" ? c.files : copy.files === "items" ? (v?.items ?? null) : null;
  const rows = `${copy.files}:${copy.add}:${!!remote}`;
  // By content: a rebuild loses focus.
  /** @type {unknown} */
  const same = copy.files === "items" ? JSON.stringify(source) : source;
  if (copy.files === "skeleton" && c.rows !== rows) buildSkeleton();
  else if (copy.files === "upload") {
    if (c.rows !== rows || c.source !== c.file) buildUpload();
    c.source = c.file;
    showUpload();
  } else if (source && (c.rows !== rows || c.source !== same)) {
    if (copy.files === "list") buildRows(/** @type {Entry[]} */ (source), copy.add);
    else buildItems(source);
    c.source = same;
  }
  c.rows = rows;
  for (const input of fileList.querySelectorAll("input")) input.checked = c.selected.includes(input.value);

  show(scope, copy.scope !== "");
  setText(scope, copy.scope);
  show(ends, copy.ends && !!v?.endsAt);
  countDown();
  renderActions(copy.actions, copy.loading);
  // An end pushed meanwhile closes Revoke's question.
  if (!copy.actions.some((a) => a.id === "end")) revokeAsk.close();
  // The remote (core/remote-ui.js, lazy): fetched on a demo claim, so it is ready at the approval.
  const on = remoteOn();
  if (demo && !remoteAsked) {
    remoteAsked = true;
    import("./core/remote-ui.js").then(
      (m) => {
        remote = m.mount(c, setView);
        render();
      },
      () => {
        remoteLost = true;
        remoteFailed();
      },
    );
  }
  remote?.(on);
  // The pick (core/match.js, lazy) on a claim with choices; a.html's skeleton pills hold its boxes until it lands.
  // A live phone never loads the remote, so the Reload toast's tappedAway touches nothing here.
  show(pickEl, key === "pick");
  if (key === "pick" && !picker) {
    picker = true;
    // A module that loads but fails to draw lands here too.
    import("./core/match.js")
      .then((m) => m.mount(c, { picked, wrong, fail }))
      .catch(() => toast({ ...RELOAD, title: "Match Didn't Load" }));
  }

  if (key === "guest_confirm" && !sender) loadSend().catch(() => {});

  // The pick's own sending state writes here too (core/match.js), so a render mid-pick leaves it.
  if (key !== "pick") setText(polite, key === "approving" ? "Approving" : "");
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
  setText(endsText, `Ends in ${countdown(left)}${offline ? " · Reconnecting" : ""}`);
  ends.classList.toggle("soon", left <= SOON_MS);
}

// Otherwise Back is a plain link (a modified click opens a tab) that keeps the pid.
back.addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (fromList()) {
    e.preventDefault();
    return toList();
  }
  if (!liveClaim(c)) return;
  e.preventDefault();
  void leave(c, io, back.getAttribute("href") ?? "/");
});

ends.addEventListener("click", () =>
  import("./core/length.js").then(
    (m) => m.openLength(c, setView),
    () => toast({ title: "You're Offline", body: "Check your connection.", error: true }),
  ),
);

fileList.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("[data-action='send-file']")) pickFile();
});

actionsEl.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("[data-action]") : null;
  const id = target?.getAttribute("data-action");
  if (id === "approve") approve();
  else if (id === "cancel") cancel();
  else if (id === "end") revokeAsk.showModal();
  else if (id === "done") void leave(c, io, "/", true);
  else if (id === "retry") retry();
  else if (id === "connect") location.assign("/auth/start");
  else if (id === "disconnect") disconnect();
  else if (id === "send-file" || id === "pick") pickFile();
  else if (id === "send") send();
});

// Fills the support mail's facts (shared/support.js) as its link shows, and again on the way to it; if they cannot
// load, the plain link stands.
function fillMail() {
  const a = actionsEl.querySelector("[data-action='mail']");
  if (a)
    import("./shared/support.js").then(
      (m) =>
        a.setAttribute(
          "href",
          m.supportMail(MAIL_SUBJECT, {
            Page: "/a",
            State: String(c.error),
            Error: c.fault,
            Time: new Date().toISOString(),
            Browser: navigator.userAgent,
          }),
        ),
      () => {},
    );
}
for (const type of ["pointerdown", "focusin"]) actionsEl.addEventListener(type, fillMail);

filePick.addEventListener("change", () => {
  if (filePick.files?.length) choose(filePick.files);
});

// Its hint: core/drag.js, lazy.
const onDrag = (/** @type {DragEvent} */ e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  if (e.type === "drop" && canAdd) choose(e.dataTransfer.files);
  import("./core/drag.js").then(
    (m) => m.hint(e.type, canAdd),
    () => {},
  );
};
addEventListener("dragenter", onDrag);
addEventListener("dragover", onDrag);
addEventListener("dragleave", onDrag);
addEventListener("drop", onDrag);

/** Its words are lazy (core/refusal.js, a rare path); if they cannot load, the general refusal says it. */
const refuse = (/** @type {import("./core/refusal.js").Problem} */ problem, /** @type {File} */ file) => {
  const maxMB = wholeMB(c.maxBytes);
  import("./core/refusal.js").then(
    (m) =>
      toast(m.refusalToast(problem, { demo: c.info?.mode === "demo", maxMB, video: kindOf(file.name) === "video" })),
    () => toast({ title: REFUSED, body: refusedLine(maxMB), error: true }),
  );
};

/** A picked or dropped file: what the phone can refuse is a toast and the page stays; otherwise the offer. */
function choose(/** @type {ArrayLike<File>} */ files) {
  const file = files[0];
  if (!file) return;
  const problem = files.length > 1 ? "several" : fileProblem(file, c.maxBytes);
  if (problem) return refuse(problem, file);
  c.file = file;
  c.drop = "confirm";
  c.error = null;
  c.retry = null;
  // Only an offer over a list has a list for Back to return to.
  if (!pushed && c.files) {
    history.pushState(null, "");
    pushed = true;
  }
  render();
}

/** Back to the list: through the history entry the offer pushed, so the browser's Back and this agree. */
function toList() {
  if (pushed) history.back();
  else showList();
}

/** Leaving the offer another way (sent, failed, canceled): its entry goes too, so Back leaves the page at once. */
function forgetEntry() {
  if (!pushed) return;
  pushed = false;
  forgetting = true;
  history.back();
}

function showList() {
  c.drop = null;
  c.file = null;
  c.error = null;
  c.retry = null;
  render();
}

addEventListener("popstate", () => {
  // forgetEntry's own Back: the page has already moved on, so there is no list to show.
  if (forgetting) {
    forgetting = false;
    return;
  }
  pushed = false;
  if (fromList()) showList();
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
}

/** Opens the native picker; it needs this click as its user gesture. The server turns the claim into a guest at the first byte. */
function pickFile() {
  c.error = null;
  c.retry = null;
  filePick.value = "";
  render();
  filePick.click();
}

/** What core/send.js needs of the page. @type {import("./types.js").SendIo} */
const sendIo = {
  render,
  setView,
  fail,
  refuse,
  retry: send,
  leaveOffer: () => (fromList() ? toList() : showList()),
  // A refusal over the list keeps the entry: Back returns to the list, as Cancel does.
  sent: () => fromList() || forgetEntry(),
};

/** Send (core/send.js, in since the offer showed); if it cannot load, a toast with Reload. */
function send() {
  // The offer's "confirm", or null on a failed send's Try Again: a Cancel or Back while it loaded changes them.
  const { file, drop: was } = c;
  loadSend().then(
    (m) => {
      if (c.file === file && c.drop === was && !c.canceling && !c.canceled) m.send(c, sendIo);
    },
    () => toast({ ...RELOAD, title: "That Didn't Load" }),
  );
}

/** On an offer or a refusal over a list, Cancel goes back to the list; Back is the one way out of that. */
function cancel() {
  if (fromList()) toList();
  else void cancelPairing();
}

/** `canceling` keeps the server's own `pairing_invalid` push, which arrives first, from showing as expired. */
async function cancelPairing() {
  c.upload?.abort();
  c.canceling = true;
  const res = await api.post("/api/cancel", {}, c.pid);
  c.canceling = false;
  if (!res.ok) return fail(res.error);
  c.canceled = true;
  forgetEntry();
  letGo();
}

/** The pairing is over on the server: its channel and its pid go. */
function letGo() {
  c.channel?.stop();
  c.channel = null;
  drop(c.pid);
  render();
}

/** A wrong pick canceled the claim server side (PAIR-14); no second guess on this code. */
function wrong() {
  c.error = "match_wrong";
  letGo();
}

/** A right pick: the chooser follows (present-live.md 3.4). */
function picked(/** @type {PhoneView} */ view) {
  setView(view);
  listOwn(view.kind);
}

/** The list is an owner's (a guest's is its Add a File row), and asked for once: a confirmed push can beat the answer. */
function listOwn(/** @type {PhoneView["kind"]} */ kind) {
  if (kind !== "guest" && !c.files && !listing) listFiles();
}

byId("revoke-end").addEventListener("click", endSession);

async function endSession() {
  const res = await api.post("/api/end", {}, c.pid);
  if (!res.ok) return fail(res.error, endSession);
  setView(res.value);
}

async function listFiles() {
  c.files = null;
  c.selected = [];
  render();
  listing = true;
  const res = await loadFiles(api, /** @type {string} */ (c.pid));
  listing = false;
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
    onView: (view) => setView(view),
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

/** What a claim or a resumed view says about the room; a guest's list is just its Add a File row. */
function learn(/** @type {ClaimResponse | PhoneView} */ x) {
  c.info = {
    roomName: x.room.name,
    registered: x.room.registered,
    match: x.match,
    choices: x.choices,
    mode: x.mode,
    kind: x.kind,
  };
  c.maxBytes = x.dropMaxBytes;
  if (x.kind === "guest") c.files = [];
}

/** @param {ClaimResponse} claim */
function paired(claim) {
  pids.set(PID_KEY, claim.pid);
  learn(claim);
  attach(claim.pid);
  render();
  if (!claim.choices) listOwn(claim.kind);
}

/** The tab's X-Bloop-Nonce: 32 random bytes as unpadded base64url, the owner of a signed-out claim's key (REL-14). */
function nonce() {
  let n = store.get("bloop.nonce");
  if (!n) {
    const b64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    n = b64.replace(/\+/g, "-").replace(/\//g, "_").slice(0, 43);
    store.set("bloop.nonce", n);
  }
  return n;
}

/**
 * One claim attempt is one Idempotency-Key, sent again by Try Again, so a lost answer replays (REL-14); api.js stays
 * as the room screen loads it. A live code refused signed out, or a code gone (unknown or expired) after sign-in, is
 * core/early.js's, with `/api/me` asked beside its load; if it cannot load, a dead code reads as its error and a live
 * one goes the guest way, which needs no sign-in.
 * @param {string} code
 * @param {string} [key]
 * @returns {Promise<void>}
 */
async function claim(code, kind = "owner", key = crypto.randomUUID(), resumed = false) {
  const headers = { "Idempotency-Key": key, "X-Bloop-Nonce": nonce() };
  const res = await createApi({
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...headers } }),
  }).post("/api/claim", { code, kind });
  if (res.ok) return paired(res.value);
  const auth = res.error === "auth_required";
  if (auth || (resumed && (res.error === "code_unknown" || res.error === "code_expired"))) {
    const who = api.get("/api/me");
    return import("./core/early.js").then(
      (m) => m.refused(res.error, { c, render, code, key, who, store, claim }),
      () => (auth ? claim(code, "guest") : fail(res.error)),
    );
  }
  fail(res.error, () => claim(code, kind, key, resumed));
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
  learn(view);
  setView(view, pid);
  attach(pid);
  if (view.confirmed && LIVE_CLAIM.includes(view.state)) listOwn(view.kind);
}

function start() {
  // The floating panel's height, so the toast sits just above it (app.css --toast-lift).
  const panel = /** @type {HTMLElement} */ (actionsEl.parentElement);
  new ResizeObserver(() => document.body.style.setProperty("--panel", `${panel.offsetHeight}px`)).observe(panel);
  if (isFramed()) {
    c.error = "framed";
    render();
    return;
  }
  render();
  reloadOnRestore();
  setInterval(countDown, 1000);
  const pid = pids.get(PID_KEY);
  const next = () => {
    if (pid) return resume(pid);
    nocode = true;
    fail("pairing_invalid");
  };
  // A code kept across sign-in is fresher than a kept pid: this tab left for sign-in a moment ago. A scan drops it.
  if (bootCode) {
    store.remove(KEPT);
    return claim(bootCode);
  }
  const kept = takeClaim(store);
  // The owner claim again with its key, so a lost answer still replays.
  if (kept) claim(kept.code, "owner", kept.key, true);
  else next();
}

start();
