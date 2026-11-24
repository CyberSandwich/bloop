// The room screen (/s): the QR and typed code, the session through its Screen object, the fallbacks; the demo's viewer.
/** @import {ScreenView} from "../../src/shared/protocol.ts" */
import { createApi } from "./core/api.js";
import { openChannel } from "./core/channel.js";
import { endLine, screenCopy } from "./core/copy.js";
import { clock, itemName, qrLabel } from "./core/format.js";
import { qrMatrix, qrPath, qrSize } from "./core/qr.js";
import { firstFile, screenKey } from "./core/states.js";
import { PID_KEY, pidStore, refOf, SID_KEY, sameScreen, sessionStore } from "./core/store.js";
import {
  CODE_GRACE_MS,
  CODE_TTL_MS,
  ENDED_HOLD_MS,
  ENDED_QR_RETURN_MS,
  ERROR_RECOVER_MS,
  OFFLINE_HINT_MS,
  pollDelay,
  ROTATE_AHEAD_MS,
} from "./core/timing.js";
import { ariaFlag, byId, el, focusTitle, frameThrottle, isFramed, lostFocus, setText, show, wsUrl } from "./core/ui.js";
import { createLauncher } from "./launcher.js";
import { createResidue } from "./residue.js";
import { format } from "./shared/codes.js";
import { ERRORS } from "./shared/errors.js";
import { IN_SESSION } from "./shared/session.js";
import { createViewer, fetchOpen } from "./viewer.js";

const api = createApi();
const store = sessionStore();
const pids = pidStore();
const DEMO = new URLSearchParams(location.search).get("mode") === "demo";

const main = byId("main");
const pane = byId("pane");
const ring = byId("ring");
const ringRect = byId("ring-rect");
const stage = byId("stage");
const heading = byId("heading");
const line = byId("line");
const qrPanel = byId("qr-panel");
const qrSvg = byId("qr");
const qrPathEl = byId("qr-path");
const matchEl = byId("match");
const typedHost = byId("typed-host");
const typedCode = byId("typed-code");
const polite = byId("polite");
const dlNote = byId("dl-note");
const controls = byId("controls");
const buttons = {
  back: byId("b-back"),
  start_over: byId("b-start-over"),
  home: byId("b-home"),
  here: byId("b-here"),
  phone: byId("b-phone"),
  continue: byId("b-continue"),
  waitlist: byId("b-waitlist"),
  copy: byId("b-copy"),
  renew: byId("b-new"),
  end: byId("b-end"),
  present: byId("b-present"),
  open: byId("b-open"),
  download: byId("b-download"),
  pdf: byId("b-pdf"),
};

/** @type {import("./types.js").ScreenPage} */
const s = {
  view: null,
  skew: 0,
  link: "ok",
  errored: false,
  limited: false,
  sid: null,
  channel: null,
  shown: null,
  scene: null,
  offlineSince: null,
  timers: {},
};

const viewer = DEMO ? createViewer({ relink: (item) => launcher.relink(item), onChange: () => render() }) : null;

// A demo launches nothing (no PowerPoint, no popup): it fetches the link itself and shows the item in the page.
const launcher = createLauncher({
  api,
  sid: () => s.sid,
  assign: (url) => (DEMO ? fetchOpen(url) : location.assign(url)),
  openWindow: (url, item, mode) => (viewer ? viewer.take(url, item, mode) : window.open(url, "bloop-pdf")),
  startDownload(url) {
    const a = el("a", { href: url, download: "" });
    document.body.append(a);
    a.click();
    a.remove();
  },
  hasGesture: () => DEMO || (navigator.userActivation?.isActive ?? true),
  report: (mode) => DEMO || (s.channel?.send({ t: "launched", mode }) ?? false),
  onChange: () => render(),
});

const residue = createResidue({
  store,
  launcher,
  storage: (() => {
    try {
      return globalThis.sessionStorage;
    } catch {
      return null;
    }
  })(),
  cleanUrl: () => history.replaceState(null, "", location.pathname + location.search),
});

const serverNow = () => Date.now() + s.skew;
/** Bumped by every renew: a boot or a channel of an older screen stops acting. */
let gen = 0;
/** The line under Session Ended, fixed when the session ends (the launcher forgets at once). */
let ended = "";

/** One named timer: setting it again replaces the old one. */
function after(/** @type {string} */ name, /** @type {number} */ ms, /** @type {() => void} */ fn) {
  clearTimeout(s.timers[name]);
  s.timers[name] = setTimeout(fn, ms);
}
const cancel = (/** @type {string} */ name) => clearTimeout(s.timers[name]);

/** The ring is the card's edge (radius 28, as app.css): its dash starts at the top center and runs clockwise. */
function fitQr() {
  const size = qrSize(innerHeight, devicePixelRatio || 1);
  qrSvg.setAttribute("width", String(size));
  qrSvg.setAttribute("height", String(size));
  const r = 28;
  const perimeter = 4 * (size - 2 * r) + 2 * Math.PI * r;
  ringRect.setAttribute("stroke-dashoffset", String((-100 * (size / 2 - r)) / perimeter));
}

function drawCode(/** @type {import("../../src/shared/protocol.ts").CodeView} */ code) {
  if (code.code === s.shown) return;
  const first = s.shown === null;
  s.shown = code.code;
  // A check beside a code it never copied would lie.
  cancel("copied");
  buttons.copy.classList.remove("is-copied");
  const paint = () => {
    qrPathEl.setAttribute("d", qrPath(qrMatrix(code.qrUrl)));
    qrSvg.setAttribute("aria-label", qrLabel(code.code, location.host));
    setText(typedCode, format(code.code));
    ring.classList.add("snap");
    updateRing();
    void ring.getBoundingClientRect();
    ring.classList.remove("snap");
    qrPanel.classList.remove("is-swapping");
  };
  if (first) paint();
  else {
    qrPanel.classList.add("is-swapping");
    setTimeout(paint, 150);
  }
}

/** The ring's length is the code's life left; the transition glides between the 1 s steps. */
function updateRing() {
  if (!s.view?.code) return;
  const from = s.view.code.expiresAt - CODE_TTL_MS;
  const left = 100 - 100 * Math.min(1, Math.max(0, (serverNow() - from) / (CODE_TTL_MS - CODE_GRACE_MS)));
  ringRect.setAttribute("stroke-dasharray", `${left} ${100 - left}`);
  // A round cap would leave a dot on an empty ring.
  ring.classList.toggle("is-out", left <= 0);
}

const MODE = {
  waiting: "waiting",
  scanned: "scanned",
  choosing: "scanned",
  guest_open: "scanned",
  demo_open: "viewer",
  ended: "ended",
};

const keyNow = () => screenKey({ view: s.view, link: s.link, errored: s.errored, limited: s.limited });

function render() {
  const key = keyNow();
  const scene = `${MODE[/** @type {keyof typeof MODE} */ (key)] ?? key}:${key === "demo_open" ? viewer?.at() : ""}`;
  const changed = s.scene !== null && scene !== s.scene;
  s.scene = scene;
  paint();
  if (!changed) return;
  pane.classList.remove("enter");
  void pane.offsetWidth;
  pane.classList.add("enter");
}

function paint() {
  const key = keyNow();
  const v = s.view;
  if (key === "demo_open") viewer?.render(v);
  else if (v && IN_SESSION.includes(v.state)) viewer?.park();
  else viewer?.render(null);
  const item = viewer?.item() ?? firstFile(v?.items ?? []);
  const copy = screenCopy(key, {
    room: v?.room.name ?? "",
    match: v?.match ?? null,
    file: item ? itemName(item) : null,
    endsAt: v?.endsAt ? clock(v.endsAt) : null,
    guest: v?.kind === "guest",
    offlineLong: s.offlineSince !== null && Date.now() - s.offlineSince >= OFFLINE_HINT_MS,
    demo: DEMO,
    openMode: v?.openMode ?? null,
    mine: sameScreen(s.sid, pids.get(PID_KEY)),
    click: launcher.needsClick(),
    endLine: ended,
    inSession: !!v?.endsAt && v.state !== "ended",
  });

  const changed = heading.textContent !== copy.heading;
  setText(heading, copy.heading);
  setText(line, copy.line);
  stage.setAttribute("role", copy.alert ? "alert" : "status");
  stage.setAttribute("aria-live", copy.alert ? "assertive" : "polite");

  const mode = MODE[/** @type {keyof typeof MODE} */ (key)] ?? "busy";
  main.dataset.mode = mode;
  controls.classList.toggle("glass", mode === "viewer");
  qrPanel.classList.toggle("is-scanned", mode === "scanned");
  const code = v?.code && mode === "waiting" ? v.code : null;
  if (code) drawCode(code);
  qrPanel.classList.toggle("is-empty", s.shown === null);
  show(matchEl, mode === "scanned");

  const has = (/** @type {import("./types.js").ScreenControl} */ c) => copy.controls.includes(c);
  show(buttons.back, !has("start_over") && !has("end") && key !== "ended");
  show(buttons.start_over, has("start_over"));
  show(buttons.home, has("end"));
  show(buttons.end, has("end"));
  show(buttons.here, has("here") && !!code);
  show(buttons.phone, has("here") && !!code);
  if (code) for (const b of [buttons.here, buttons.phone]) b.setAttribute("href", `/a?c=${code.code}`);
  show(buttons.continue, has("continue"));
  show(buttons.waitlist, has("waitlist"));
  show(buttons.open, has("open") || launcher.needsClick());
  // A spent mint budget hides the item's fallbacks: another click could only be refused.
  const mintable = !launcher.spent(target());
  const viewing = key === "demo_open";
  // The viewer's Download is the item's; `approved` refuses a download mint until the first fetch opens the session.
  const download = viewing
    ? item?.kind === "file" && v?.state !== "approved"
    : has("download") && (key !== "opening" || launcher.downloadReady());
  show(buttons.download, mintable && download);
  show(dlNote, !DEMO && mintable && download);
  setText(buttons.download, viewing || key === "open_fallback" ? "Download" : "Download It Instead");
  show(buttons.pdf, mintable && has("pdf"));
  show(buttons.present, viewing && !!viewer?.presentable());

  // With the sidebar showing, the h1 is visually hidden: focus lands on the selected row instead.
  const row = document.querySelector("#items [aria-current]");
  if (changed && lostFocus()) focusTitle(row instanceof HTMLElement && row.offsetParent ? row : heading);
  if (mode === "waiting") updateRing();
  schedule(key);
}

function schedule(/** @type {import("../../src/shared/protocol.ts").ScreenStateKey} */ key) {
  const v = s.view;
  if (key === "waiting" && v) {
    if (!v.code) after("rotate", 0, requestCode);
    else after("rotate", Math.max(0, v.code.expiresAt - ROTATE_AHEAD_MS - serverNow()), requestCode);
  } else cancel("rotate");

  if (key === "ended") after("ended", ended || DEMO ? ENDED_HOLD_MS : ENDED_QR_RETURN_MS, requestCode);
  else cancel("ended");

  if (key === "error") after("error", ERROR_RECOVER_MS, recover);
  else cancel("error");

  const waited = s.offlineSince === null ? OFFLINE_HINT_MS : Date.now() - s.offlineSince;
  if (key === "offline" && waited < OFFLINE_HINT_MS) after("hint", OFFLINE_HINT_MS - waited, render);
  else cancel("hint");
}

function requestCode() {
  s.channel?.send({ t: "code.next" });
}

function recover() {
  s.errored = false;
  render();
  s.channel?.refresh();
}

function onView(/** @type {ScreenView} */ view) {
  if (view.state === "ended" && s.view?.state !== "ended") {
    ended = DEMO ? "" : endLine(view.endReason, launcher.left());
  }
  if ((view.state === "ended" || view.state === "closed") && sameScreen(s.sid, pids.get(PID_KEY))) pids.remove(PID_KEY);
  s.view = view;
  s.skew = view.now - Date.now();
  if (view.state === "ended" || view.state === "closed") residue.clear();
  // The credential is the screen's own, not the session's: it comes back so a reload resumes the waiting screen.
  else if (view.state === "waiting" && s.sid && store.get(SID_KEY) !== s.sid) store.set(SID_KEY, s.sid);
  launcher.onView(view);
  render();
}

function onLink(/** @type {"ok" | "offline" | "down"} */ link) {
  s.link = link;
  s.offlineSince = link === "offline" ? (s.offlineSince ?? Date.now()) : null;
  render();
}

function onError(/** @type {import("../../src/shared/protocol.ts").ErrorCode} */ code) {
  const target = ERRORS[code].screen;
  if (code === "unauthorized" || code === "screen_gone") return renew();
  if (target === "error" || target === "service_down") flagError();
}

function flagError() {
  s.errored = true;
  render();
}

/** Stops the socket; a pending boot of an older gen drops out. */
function letGo() {
  gen += 1;
  s.channel?.stop();
  s.channel = null;
}

/** The credential is dead: forget it and open a new screen. */
function renew() {
  letGo();
  store.remove(SID_KEY);
  s.sid = null;
  s.view = null;
  s.shown = null;
  setText(typedCode, "");
  qrPanel.classList.add("is-empty");
  boot();
}

async function act(/** @type {string} */ path) {
  const res = await api.post(path, {}, s.sid);
  if (res.ok) onView(res.value);
  else if (res.error === "unauthorized" || res.error === "screen_gone") renew();
  else flagError();
}

buttons.start_over.addEventListener("click", () => act("/api/screen/restart"));
buttons.end.addEventListener("click", () => act("/api/screen/end"));
// The logo opens an in-page question (s.html #leave, a popover); only its End and Go Home ends.
// Home even if the end fails (it times out); the sid goes, so the browser's Back cannot resume it.
byId("b-leave").addEventListener("click", async () => {
  letGo();
  await api.post("/api/screen/end", {}, s.sid);
  store.remove(SID_KEY);
  location.assign("/");
});
// Back ends a waiting screen (code and demo slot gone at once), the socket stopped first so nothing renews.
buttons.back.addEventListener("click", () => {
  const waiting = s.view?.state === "waiting";
  letGo();
  if (s.sid && waiting) void api.leave("/api/screen/end", s.sid);
});
buttons.present.addEventListener("click", () => viewer?.present());
buttons.copy.addEventListener("click", () => {
  if (!s.shown) return;
  navigator.clipboard?.writeText(format(s.shown)).then(
    () => {
      buttons.copy.classList.add("is-copied");
      setText(polite, "Copied");
      after("copied", 1500, () => {
        buttons.copy.classList.remove("is-copied");
        setText(polite, "");
      });
    },
    () => {},
  );
});
buttons.renew.addEventListener("click", async () => {
  // aria-disabled, not disabled: the button keeps focus while the new screen loads.
  if (buttons.renew.getAttribute("aria-disabled")) return;
  ariaFlag(buttons.renew, "aria-disabled", true);
  letGo();
  await api.post("/api/screen/end", {}, s.sid);
  renew();
});
buttons.open.addEventListener("click", () => {
  if (s.view?.state !== "offered") return launcher.click();
  if (!s.channel?.send({ t: "open.click" })) flagError();
});
const target = () => (viewer?.item() ? viewer.at() : undefined);

const fallback = (/** @type {() => Promise<import("./types.js").Minted>} */ run) => async () => {
  if ((await run()) === "failed") flagError();
};
buttons.download.addEventListener(
  "click",
  fallback(() => launcher.download(target())),
);
buttons.pdf.addEventListener("click", fallback(launcher.showPdf));

function connect(/** @type {string} */ sid) {
  s.sid = sid;
  // A channel that is no longer current (a renew replaced it) is ignored, whatever it still delivers.
  const ch = openChannel({
    url: `${wsUrl("/api/screen/ws")}?ref=${refOf(sid)}`,
    statePath: "/api/screen/state",
    credential: sid,
    helloKey: "sid",
    api,
    connect: (url) => new WebSocket(url),
    onView: (view) => ch === s.channel && onView(view),
    onError: (code) => ch === s.channel && onError(code),
    onFrame: (frame) => {
      if (ch === s.channel && frame.t === "open") launcher.launch(frame.links, frame.item);
    },
    onLink: (link) => ch === s.channel && onLink(link),
  });
  s.channel = ch;
}

/** The stored screen of this page's mode, or null; only the tab that created it holds its sid. */
async function resume() {
  const sid = store.get(SID_KEY);
  if (!sid) return null;
  const res = await api.get("/api/screen/state", sid);
  if (!res.ok && (res.error === "offline" || res.error === "service_down")) {
    return /** @type {import("./types.js").Booted} */ ({ ok: false, error: res.error });
  }
  if (res.ok && res.value.mode === (DEMO ? "demo" : "live"))
    return /** @type {import("./types.js").Booted} */ ({ ok: true, sid, view: res.value });
  // A screen of the other mode would otherwise keep its session (and a demo slot) until it timed out.
  if (res.ok) await api.post("/api/screen/end", {}, sid);
  residue.forget();
  return null;
}

/** @returns {Promise<import("./types.js").Booted>} */
async function create() {
  const res = await api.post("/api/screens", { mode: DEMO ? "demo" : "live" });
  if (!res.ok) return { ok: false, error: res.error };
  store.set(SID_KEY, res.value.sid);
  return { ok: true, sid: res.value.sid, view: res.value.view };
}

/** Resumes or creates the screen, with backoff while offline or refused. */
async function boot(attempt = 0) {
  const g = gen;
  const booted = (await resume()) ?? (await create());
  if (g !== gen) return;
  s.limited = !booted.ok && booted.error === "rate_limited";
  if (!booted.ok) {
    s.link = booted.error === "offline" ? "offline" : "down";
    s.offlineSince = s.link === "offline" ? (s.offlineSince ?? Date.now()) : null;
    render();
    setTimeout(() => g === gen && boot(attempt + 1), pollDelay(attempt + 1));
    return;
  }
  ariaFlag(buttons.renew, "aria-disabled", false);
  s.link = "ok";
  s.offlineSince = null;
  // The sid first: the first view can already ask for a link.
  s.sid = booted.sid;
  onView(booted.view);
  connect(booted.sid);
}

function start() {
  if (isFramed()) return;
  // A phone may run the demo (it approves on itself); a live screen needs a room-sized window.
  if (DEMO) document.body.classList.add("is-demo");
  else if (matchMedia("(max-width: 599.98px)").matches) return;
  main.dataset.mode = "idle";
  typedHost.textContent = location.host;
  setText(byId("phone-host"), location.host);
  fitQr();
  addEventListener("resize", frameThrottle(fitQr));
  addEventListener("online", () => s.channel?.nudge());
  addEventListener("pagehide", () => launcher.closePdf());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) s.channel?.nudge();
  });
  setInterval(() => (main.dataset.mode === "waiting" ? updateRing() : undefined), 1000);
  boot();
}

start();
