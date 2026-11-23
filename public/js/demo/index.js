// The live demo in the landing stage: a real demo screen (mode "demo") drawn into the stage's screen mock, with the
// phone mock echoing the real /a sheet. Loaded lazily by landing.js on a fine pointer, so it has its own size entry.
// Every state change is announced as a `bloop:demo` event on the stage; landing.js turns it into robin poses.
// The stage cannot launch PowerPoint for a visitor: it fetches the open link itself, as PowerPoint would, to
// reach the open state. /s?mode=demo is the full-screen demo that really launches.
/** @import {ScreenView} from "../../../src/shared/protocol.ts" */
import { createApi } from "../core/api.js";
import { openChannel } from "../core/channel.js";
import { phoneCopy } from "../core/copy.js";
import { clock, qrLabel } from "../core/format.js";
import { qrMatrix, qrPath } from "../core/qr.js";
import { screenKey } from "../core/states.js";
import { CODE_GRACE_MS, CODE_TTL_MS, ENDED_QR_RETURN_MS, pollDelay, ROTATE_AHEAD_MS } from "../core/timing.js";
import { byId, el, setText, show, wsUrl } from "../core/ui.js";
import { ERRORS } from "../shared/errors.js";
import { phoneMockKey, stageCopy, stageState } from "./stage.js";

const PROTOCOL_PREFIX = "ms-powerpoint:ofv|u|";
const ROOM = "Demo room";

/**
 * Starts the demo in the stage. Safe to call once per page.
 * @param {HTMLElement} orbit the stage (#demo)
 */
export function startDemo(orbit) {
  const api = createApi();
  const screenMock = /** @type {HTMLElement} */ (orbit.querySelector(".orbit-screen"));
  const heading = byId("demo-heading");
  const line = byId("demo-line");
  const action = byId("demo-action");
  const qrBox = byId("demo-qr");
  const qrSvg = byId("demo-qr-svg");
  const qrPathEl = byId("demo-qr-path");
  const matchEl = byId("demo-match");
  const capsule = byId("demo-capsule");
  const capsuleFill = byId("demo-capsule-fill");
  const phoneTitle = byId("demo-phone-title");
  const phoneBody = byId("demo-phone-body");
  const phoneActions = byId("demo-phone-actions");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** @type {{sid: string | null, channel: ReturnType<typeof openChannel> | null, view: ScreenView | null, link: "ok" | "offline" | "down", errored: boolean, limited: boolean, shown: string | null, state: string | null, skew: number, timers: Record<string, ReturnType<typeof setTimeout> | undefined>}} */
  const s = {
    sid: null,
    channel: null,
    view: null,
    link: "ok",
    errored: false,
    limited: false,
    shown: null,
    state: null,
    skew: 0,
    timers: {},
  };

  const after = (/** @type {string} */ name, /** @type {number} */ ms, /** @type {() => void} */ fn) => {
    clearTimeout(s.timers[name]);
    s.timers[name] = setTimeout(fn, ms);
  };
  const cancel = (/** @type {string} */ name) => clearTimeout(s.timers[name]);

  function drawCode(/** @type {import("../../../src/shared/protocol.ts").CodeView} */ code) {
    if (code.code === s.shown) return;
    s.shown = code.code;
    qrPathEl.setAttribute("d", qrPath(qrMatrix(code.qrUrl)));
    qrSvg.setAttribute("role", "img");
    qrSvg.setAttribute("aria-label", qrLabel(code.code, location.host));
    qrSvg.dataset.code = code.code;
    capsuleFill.style.transition = "none";
    capsuleFill.style.transform = "scaleX(0)";
    void capsuleFill.offsetWidth;
    capsuleFill.style.transition = "";
  }

  function updateCapsule() {
    const code = s.view?.code;
    if (!code) return;
    const p = (Date.now() + s.skew - (code.expiresAt - CODE_TTL_MS)) / (CODE_TTL_MS - CODE_GRACE_MS);
    capsuleFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  }

  /** The phone mock: the real sheet's title, body and buttons, or nothing while the phone has none. */
  function drawPhone(/** @type {import("./stage.js").StageState} */ state) {
    const key = phoneMockKey(state);
    const v = s.view;
    const copy = key
      ? phoneCopy(key, { room: ROOM, file: v?.fileName ?? null, endsAt: v?.endsAt ? clock(v.endsAt) : null })
      : null;
    setText(phoneTitle, copy?.title ?? "");
    setText(phoneBody, copy ? copy.body || copy.scope : "");
    phoneActions.replaceChildren(
      ...(copy?.actions
        .filter((a) => a.kind !== "text")
        .map((a) => el("span", { class: `btn ${a.kind}` }, [a.label])) ?? []),
    );
  }

  /** The mock was decoration until the first real state; with a live code and a button it is real UI. */
  function goLive() {
    screenMock.removeAttribute("inert");
    screenMock.removeAttribute("aria-hidden");
    orbit.classList.add("is-live");
  }

  function render() {
    const state = stageState(screenKey({ view: s.view, link: s.link, errored: s.errored, limited: s.limited }));
    if (state === null) return;
    goLive();
    const v = s.view;
    const copy = stageCopy(state, v?.match ?? null);
    setText(heading, copy.heading);
    setText(line, copy.line);
    show(action, copy.action !== null);
    setText(action, copy.action ?? "");
    show(qrBox, state === "waiting" || state === "scanned");
    qrBox.classList.toggle("is-scanned", state === "scanned");
    show(matchEl, state === "scanned" && !!v?.match);
    setText(matchEl, state === "scanned" ? (v?.match ?? "") : "");
    show(capsule, state === "waiting");
    if (state === "waiting" && v?.code) {
      drawCode(v.code);
      updateCapsule();
    }
    drawPhone(state);
    if (s.state !== state) {
      s.state = state;
      orbit.dataset.demo = state;
      orbit.dispatchEvent(new CustomEvent("bloop:demo", { detail: { state } }));
    }
    schedule(state);
  }

  /** Code rotation and the way back from ended. A hidden tab asks for nothing; it catches up when shown. */
  function schedule(/** @type {string} */ state) {
    const v = s.view;
    if (state === "waiting" && v) {
      const wait = v.code ? Math.max(0, v.code.expiresAt - ROTATE_AHEAD_MS - (Date.now() + s.skew)) : 0;
      after("rotate", wait, requestCode);
    } else cancel("rotate");
    if (state === "ended") after("ended", ENDED_QR_RETURN_MS, requestCode);
    else cancel("ended");
  }

  function requestCode() {
    if (!document.hidden) s.channel?.send({ t: "code.next" });
  }

  function onView(/** @type {ScreenView} */ view) {
    s.view = view;
    s.skew = view.now - Date.now();
    render();
  }

  /** PowerPoint's fetch of the open link, made by the page so the stage reaches the open state. */
  function fetchOpenLink(/** @type {string | null} */ protocol) {
    if (!protocol?.startsWith(PROTOCOL_PREFIX)) return;
    const url = new URL(protocol.slice(PROTOCOL_PREFIX.length));
    if (url.origin !== location.origin) return;
    fetch(url.href, { method: "HEAD", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }).catch(
      () => {},
    );
  }

  function fail() {
    s.errored = true;
    render();
  }

  function connect(/** @type {string} */ sid) {
    s.channel = openChannel({
      url: `${wsUrl("/api/screen/ws")}?ref=${sid.split(".")[0]}`,
      statePath: "/api/screen/state",
      credential: sid,
      helloKey: "sid",
      api,
      connect: (url) => new WebSocket(url),
      onView,
      onError(code) {
        if (code === "unauthorized" || code === "screen_gone") return begin();
        if (ERRORS[code].screen === "error" || ERRORS[code].screen === "service_down") fail();
      },
      onFrame(frame) {
        if (frame.t !== "open") return;
        s.channel?.send({ t: "launched", mode: "protocol" });
        fetchOpenLink(frame.links?.protocol ?? null);
      },
      onLink(link) {
        s.link = link;
        render();
      },
    });
  }

  /**
   * Opens a new demo screen. The demo caps (`rate_limited`) show their own state and retry with backoff; any other
   * refusal (demo off, a bad answer) shows the error state and Try Again.
   */
  async function begin(attempt = 0) {
    s.channel?.stop();
    s.channel = null;
    s.errored = false;
    s.shown = null;
    const res = await api.post("/api/screens", { mode: "demo" });
    s.limited = !res.ok && res.error === "rate_limited";
    if (s.limited) {
      s.view = null;
      render();
      setTimeout(() => begin(attempt + 1), pollDelay(attempt + 1));
      return;
    }
    if (!res.ok) {
      // The network, not the server, said no: try again quietly a few times before showing the error.
      if ((res.error === "offline" || res.error === "service_down") && attempt < 2) {
        setTimeout(() => begin(attempt + 1), pollDelay(attempt + 1));
        return;
      }
      s.view = null;
      return fail();
    }
    s.sid = res.value.sid;
    s.link = "ok";
    onView(res.value.view);
    connect(res.value.sid);
  }

  action.addEventListener("click", async () => {
    if (s.state === "error") return begin();
    if (!s.sid) return;
    const res = await api.post("/api/screen/end", {}, s.sid);
    if (res.ok) onView(res.value);
    else begin();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    s.channel?.nudge();
    if (s.state) schedule(s.state);
  });
  setInterval(() => (s.state === "waiting" ? updateCapsule() : undefined), reduced ? 10_000 : 1000);

  return begin();
}
