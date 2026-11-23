// The room screen (/s): shows the QR and the typed code, follows the session through its Screen
// object, and offers Start Over, End, Open and the download and PDF fallbacks. State strings live in core/copy.js.
/** @import {ScreenView} from "../../src/shared/protocol.ts" */
import { createApi } from "./core/api.js";
import { openChannel } from "./core/channel.js";
import { screenCopy } from "./core/copy.js";
import { clock, qrLabel } from "./core/format.js";
import { qrMatrix, qrPath, qrSize } from "./core/qr.js";
import { screenKey } from "./core/states.js";
import { SID_KEY, sessionStore } from "./core/store.js";
import {
  CODE_GRACE_MS,
  CODE_TTL_MS,
  ENDED_QR_RETURN_MS,
  ERROR_RECOVER_MS,
  OFFLINE_HINT_MS,
  pollDelay,
  ROTATE_AHEAD_MS,
} from "./core/timing.js";
import { byId, el, focusTitle, frameThrottle, isFramed, lostFocus, setText, show, wsUrl } from "./core/ui.js";
import { createLauncher } from "./launcher.js";
import { createResidue } from "./residue.js";
import { format } from "./shared/codes.js";
import { ERRORS } from "./shared/errors.js";

const api = createApi();
const store = sessionStore();

const main = byId("main");
const stage = byId("stage");
const heading = byId("heading");
const line = byId("line");
const chip = byId("chip");
const chipText = byId("chip-text");
const chipCheck = byId("chip-check");
const chipWifi = byId("chip-wifi");
const qrPanel = byId("qr-panel");
const qrSvg = byId("qr");
const qrPathEl = byId("qr-path");
const matchEl = byId("match");
const capsuleFill = byId("capsule-fill");
const typedHost = byId("typed-host");
const typedCode = byId("typed-code");
const buttons = {
  start_over: byId("b-start-over"),
  end: byId("b-end"),
  open: byId("b-open"),
  download: byId("b-download"),
  pdf: byId("b-pdf"),
};

/**
 * @type {{
 *   view: ScreenView | null, skew: number, link: "ok" | "offline" | "down", errored: boolean, limited: boolean,
 *   sid: string | null, channel: ReturnType<typeof openChannel> | null, shown: string | null,
 *   expiresAt: number, offlineSince: number | null, timers: Record<string, ReturnType<typeof setTimeout> | undefined>
 * }}
 */
const s = {
  view: null,
  skew: 0,
  link: "ok",
  errored: false,
  limited: false,
  sid: null,
  channel: null,
  shown: null,
  expiresAt: 0,
  offlineSince: null,
  timers: {},
};

const launcher = createLauncher({
  api,
  sid: () => s.sid,
  assign: (url) => location.assign(url),
  openWindow: (url) => window.open(url, "bloop-pdf"),
  startDownload(url) {
    const a = el("a", { href: url, download: "" });
    document.body.append(a);
    a.click();
    a.remove();
  },
  hasGesture: () => navigator.userActivation?.isActive ?? true,
  report: (mode) => s.channel?.send({ t: "launched", mode }) ?? false,
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

const DEMO = new URLSearchParams(location.search).get("mode") === "demo";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const serverNow = () => Date.now() + s.skew;

/** One named timer: setting it again replaces the old one. */
function after(/** @type {string} */ name, /** @type {number} */ ms, /** @type {() => void} */ fn) {
  clearTimeout(s.timers[name]);
  s.timers[name] = setTimeout(fn, ms);
}
const cancel = (/** @type {string} */ name) => clearTimeout(s.timers[name]);

function fitQr() {
  const size = qrSize(innerHeight, devicePixelRatio || 1);
  qrSvg.setAttribute("width", String(size));
  qrSvg.setAttribute("height", String(size));
}

function drawCode(/** @type {import("../../src/shared/protocol.ts").CodeView} */ code) {
  if (code.code === s.shown) return;
  const first = s.shown === null;
  s.shown = code.code;
  const paint = () => {
    qrPathEl.setAttribute("d", qrPath(qrMatrix(code.qrUrl)));
    qrSvg.setAttribute("aria-label", qrLabel(code.code, location.host));
    setText(typedCode, format(code.code));
    capsuleFill.style.transition = "none";
    capsuleFill.style.transform = "scaleX(0)";
    void capsuleFill.offsetWidth;
    capsuleFill.style.transition = "";
    qrPanel.classList.remove("is-swapping");
  };
  if (first) paint();
  else {
    qrPanel.classList.add("is-swapping");
    setTimeout(paint, 150);
  }
}

function updateCapsule() {
  if (!s.view?.code) return;
  const from = s.view.code.expiresAt - CODE_TTL_MS;
  const p = (serverNow() - from) / (CODE_TTL_MS - CODE_GRACE_MS);
  capsuleFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
}

const poster = /** @type {HTMLElement | null} */ (document.querySelector(".poster-slot img"));
let scannedBefore = false;

/** The poster robin hops once per scan (design.md section 8); CSS holds it still under reduced motion. */
function hopOnScan(/** @type {boolean} */ scanned) {
  if (scanned && !scannedBefore && poster) {
    poster.classList.remove("is-hop");
    void poster.offsetWidth;
    poster.classList.add("is-hop");
  }
  scannedBefore = scanned;
}

const MODE = {
  waiting: "waiting",
  scanned: "scanned",
  choosing: "scanned",
  guest_open: "scanned",
};

function render() {
  const key = screenKey({ view: s.view, link: s.link, errored: s.errored, limited: s.limited });
  const v = s.view;
  const copy = screenCopy(key, {
    room: v?.room.name ?? "",
    match: v?.match ?? null,
    file: v?.fileName ?? null,
    endsAt: v?.endsAt ? clock(v.endsAt) : null,
    guest: v?.kind === "guest",
    offlineLong: s.offlineSince !== null && Date.now() - s.offlineSince >= OFFLINE_HINT_MS,
    demo: DEMO,
  });

  const changed = heading.textContent !== copy.heading;
  setText(heading, copy.heading);
  setText(line, copy.line);
  stage.setAttribute("role", copy.alert ? "alert" : "status");
  stage.setAttribute("aria-live", copy.alert ? "assertive" : "polite");

  const mode = MODE[/** @type {keyof typeof MODE} */ (key)] ?? "busy";
  main.dataset.mode = mode;
  qrPanel.classList.toggle("is-scanned", mode === "scanned");
  hopOnScan(mode === "scanned");
  const code = v?.code && mode === "waiting" ? v.code : null;
  if (code) drawCode(code);
  qrPanel.classList.toggle("is-empty", s.shown === null);
  show(matchEl, mode === "scanned" && !!v?.match);
  setText(matchEl, mode === "scanned" ? (v?.match ?? "") : "");

  show(chip, copy.chip !== null);
  setText(chipText, copy.chip ?? "");
  show(chipCheck, copy.chipIcon === "check");
  show(chipWifi, copy.chipIcon === "wifi-off");

  show(buttons.start_over, copy.controls.includes("start_over"));
  show(buttons.end, copy.controls.includes("end"));
  // Open: the guest's offer, or a launch that needs a click (no user gesture, or a blocked popup).
  show(buttons.open, copy.controls.includes("open") || launcher.needsClick());
  show(buttons.download, copy.controls.includes("download") && (key !== "opening" || launcher.downloadReady()));
  show(buttons.pdf, copy.controls.includes("pdf"));
  setText(buttons.download, key === "open_fallback" ? "Download" : "Download It Instead");

  if (changed && lostFocus()) focusTitle(heading);
  if (mode === "waiting") updateCapsule();
  schedule(key);
}

/** Timers that follow from the state: code rotation, the way back from ended and from an error. */
function schedule(/** @type {import("../../src/shared/protocol.ts").ScreenStateKey} */ key) {
  const v = s.view;
  if (key === "waiting" && v) {
    if (!v.code) after("rotate", 0, requestCode);
    else after("rotate", Math.max(0, v.code.expiresAt - ROTATE_AHEAD_MS - serverNow()), requestCode);
  } else cancel("rotate");

  if (key === "ended") after("ended", ENDED_QR_RETURN_MS, requestCode);
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

/** The credential is dead: forget it and open a new screen. */
function renew() {
  s.channel?.stop();
  s.channel = null;
  store.remove(SID_KEY);
  s.sid = null;
  s.view = null;
  s.shown = null;
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
buttons.open.addEventListener("click", () => {
  if (s.view?.state !== "offered") return launcher.click();
  if (!s.channel?.send({ t: "open.click" })) flagError();
});
/** A fallback that could not be minted shows the error state, which recovers by itself. */
const fallback = (/** @type {() => Promise<boolean>} */ run) => async () => {
  if (!(await run())) flagError();
};
buttons.download.addEventListener("click", fallback(launcher.download));
buttons.pdf.addEventListener("click", fallback(launcher.showPdf));

function connect(/** @type {string} */ sid) {
  s.sid = sid;
  s.channel = openChannel({
    url: `${wsUrl("/api/screen/ws")}?ref=${sid.split(".")[0]}`,
    statePath: "/api/screen/state",
    credential: sid,
    helloKey: "sid",
    api,
    connect: (url) => new WebSocket(url),
    onView,
    onError,
    onFrame: (frame) => {
      if (frame.t === "open") launcher.launch(frame.links);
    },
    onLink,
  });
}

/** @typedef {{ok: true, sid: string, view: ScreenView} | {ok: false, error: string}} Booted */

/** The stored screen, when it still exists; null when there is none or it is gone. */
async function resume() {
  const sid = store.get(SID_KEY);
  if (!sid) return null;
  const res = await api.get("/api/screen/state", sid);
  if (res.ok) return /** @type {Booted} */ ({ ok: true, sid, view: res.value });
  if (res.error === "offline" || res.error === "service_down")
    return /** @type {Booted} */ ({ ok: false, error: res.error });
  store.remove(SID_KEY);
  return null;
}

/** @returns {Promise<Booted>} */
async function create() {
  const res = await api.post("/api/screens", { mode: DEMO ? "demo" : "live" });
  if (!res.ok) return { ok: false, error: res.error };
  store.set(SID_KEY, res.value.sid);
  return { ok: true, sid: res.value.sid, view: res.value.view };
}

/** Resumes the stored screen, or creates one. Retries with backoff while the network is down or the demo caps refuse. */
async function boot(attempt = 0) {
  const booted = (await resume()) ?? (await create());
  s.limited = !booted.ok && booted.error === "rate_limited";
  if (!booted.ok) {
    s.link = booted.error === "offline" ? "offline" : "down";
    s.offlineSince = s.link === "offline" ? (s.offlineSince ?? Date.now()) : null;
    render();
    setTimeout(() => boot(attempt + 1), pollDelay(attempt + 1));
    return;
  }
  s.link = "ok";
  s.offlineSince = null;
  onView(booted.view);
  connect(booted.sid);
}

function start() {
  if (isFramed()) return;
  if (matchMedia("(max-width: 599.98px)").matches) return;
  main.dataset.mode = "idle";
  typedHost.textContent = location.host;
  fitQr();
  addEventListener("resize", frameThrottle(fitQr));
  addEventListener("online", () => s.channel?.nudge());
  addEventListener("pagehide", () => launcher.closePdf());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) s.channel?.nudge();
  });
  setInterval(() => (main.dataset.mode === "waiting" ? updateCapsule() : undefined), reduceMotion ? 10_000 : 1000);
  boot();
}

start();
