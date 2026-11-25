// Live updates for one credential, screen or phone (docs/architecture.md section 7). The credential travels in the
// first frame, never in the URL.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {ChannelOptions, SocketLike} from "../types.js" */
import {
  BLOCKED_PROBE_MS,
  COALESCE_MS,
  CONNECT_TIMEOUT_MS,
  jitter,
  reconnectDelay,
  shouldPoll,
} from "./channel-timing.js";

/** Errors after which the credential is dead and retrying is pointless. */
export const FATAL = /** @type {ReadonlySet<ErrorCode>} */ (
  new Set(["unauthorized", "pairing_invalid", "screen_gone"])
);

/** A refused read: dead drops the credential; the rest retry. @param {ErrorCode} code */
export const refusal = (code) =>
  code === "offline" || code === "service_down" ? "offline" : FATAL.has(code) ? "dead" : "retry";

/** The tab's memory that its network swallows the socket; not a `bloop.` key, so a session's end keeps it. */
const BLOCKED_KEY = "ws";

/** @typedef {{t: string, [key: string]: unknown}} Frame */

/** @param {ChannelOptions} o */
export function openChannel(o) {
  let closed = false;
  let failures = 0;
  let live = false;
  /** @type {SocketLike | null} */
  let socket = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let connectTimer = null;
  /** The ping rule, loaded when a socket opens. @type {ReturnType<typeof import("./health.js").watch> | null} */
  let health = null;
  /** Connect timeouts in a row with no socket ever opening. */
  let timeouts = 0;
  let lastHeard = 0;
  /** State frames seen: a read older than a push is stale. */
  let pushed = 0;
  /** The last view's state: how often a poll is worth making. */
  let lastState = "";
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sendTimer = null;
  /** Frames sent inside the window, the latest of each type. @type {Map<string, Frame>} */
  const pending = new Map();
  const hidden = () => /** @type {any} */ (globalThis).document.hidden;
  /** The tab's blocked flag: read with no argument, set or cleared with one. @param {boolean} [set] */
  const flag = (set) => {
    try {
      if (set === undefined) return sessionStorage.getItem(BLOCKED_KEY) === "blocked";
      if (set) sessionStorage.setItem(BLOCKED_KEY, "blocked");
      else sessionStorage.removeItem(BLOCKED_KEY);
    } catch {
      // storage blocked: the next screen probes first
    }
    return false;
  };

  const clear = () => {
    for (const t of [retryTimer, connectTimer, sendTimer]) if (t) clearTimeout(t);
    health?.stop();
    retryTimer = connectTimer = sendTimer = health = null;
    pending.clear();
  };

  /** The polling fallback loads the first time it is needed. @type {Promise<ReturnType<typeof import("./poll.js").createPoller>> | null} */
  let poller = null;
  const poll = () =>
    (poller ??= import("./poll.js").then((m) =>
      m.createPoller({
        api: o.api,
        path: o.statePath,
        auth: o.credential,
        hidden,
        state: () => lastState,
        active: () => !closed && !live,
        fatal: (code) => {
          if (!FATAL.has(code)) return false;
          stop();
          o.onError(code);
          return true;
        },
        onView: (view) => {
          lastState = view?.state ?? lastState;
          o.onView(view);
        },
        onLink: o.onLink,
      }),
    ));
  /** Polls now; one loop at a time. */
  const startPolling = () => {
    if (!closed && !live) void poll().then((p) => !closed && !live && p.start());
  };
  const stopPolling = () => void poller?.then((p) => p.stop());

  function lost() {
    if (closed) return;
    live = false;
    if (connectTimer) clearTimeout(connectTimer);
    health?.stop();
    connectTimer = health = socket = null;
    pending.clear();
    failures += 1;
    if (shouldPoll(failures)) startPolling();
    retryTimer = setTimeout(connect, flag() ? jitter(BLOCKED_PROBE_MS) : reconnectDelay(failures));
  }

  function connect() {
    retryTimer = null;
    if (closed || socket) return;
    const ws = o.connect(o.url);
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      lastHeard = Date.now();
      ws.send(JSON.stringify({ v: 1, t: "hello", [o.helloKey]: o.credential }));
      void import("./health.js").then((m) => {
        if (socket !== ws) return;
        health = m.watch({
          ws,
          heard: () => lastHeard,
          hidden,
          drop,
          replace: (w) => {
            drop(w);
            nudge();
          },
        });
      });
    };
    ws.onmessage = (e) => {
      lastHeard = Date.now();
      /** @type {any} */
      let frame;
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (frame?.v !== 1) return;
      if (frame.t === "pong") return;
      if (!live) {
        live = true;
        failures = 0;
        timeouts = 0;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        flag(false);
        stopPolling();
        o.onLink("ok");
      }
      if (frame.t === "state") {
        pushed += 1;
        lastState = frame.view?.state ?? lastState;
        o.onView(frame.view);
      } else if (frame.t === "error") {
        if (FATAL.has(frame.code)) stop();
        o.onError(frame.code);
      } else o.onFrame?.(frame);
    };
    ws.onclose = ws.onerror = () => drop(ws);
    // A proxy that holds the upgrade (or the first frame) fires neither close nor error: poll now, retry the socket.
    // Two in a row with the socket never opening say the network swallows it, which the tab remembers.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (socket !== ws || live) return;
      if (!opened) timeouts += 1;
      if (timeouts >= 2) flag(true);
      startPolling();
      drop(ws);
    }, CONNECT_TIMEOUT_MS);
  }

  /** The one way a socket is given up: no handler of it fires again, and the channel retries or polls. @param {SocketLike} ws */
  function drop(ws) {
    if (socket !== ws) return;
    ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
    ws.close();
    lost();
  }

  function stop() {
    closed = true;
    clear();
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      ws.close();
    }
  }

  // A tab that already found its socket blocked polls from the first second and tries the socket once a minute.
  if (flag()) {
    startPolling();
    retryTimer = setTimeout(connect, jitter(BLOCKED_PROBE_MS));
  } else connect();

  return {
    /**
     * The first frame goes at once; the rest inside COALESCE_MS go together after it, the latest of each type, so a
     * burst of taps sends absolute values (a page), never deltas.
     * @param {Frame} frame
     */
    send(frame) {
      if (!live || !socket) return false;
      if (sendTimer) pending.set(frame.t, frame);
      else {
        socket.send(JSON.stringify({ v: 1, ...frame }));
        sendTimer = setTimeout(flush, COALESCE_MS);
      }
      return true;
    },
    nudge,
    refresh,
    /**
     * The tab is visible again. A live socket is pinged when it has been quiet; one that is down reconnects, and its
     * hello carries the state (no read), or, polling, the next poll comes now.
     */
    wake() {
      if (live) return health?.probe();
      nudge();
      void poller?.then((p) => p.soon());
    },
    stop,
  };

  function flush() {
    sendTimer = null;
    const frames = [...pending.values()];
    pending.clear();
    if (!live || !socket || !frames.length) return;
    for (const f of frames) socket.send(JSON.stringify({ v: 1, ...f }));
    sendTimer = setTimeout(flush, COALESCE_MS);
  }

  /** Retry now: the tab became visible again, or the network came back. */
  function nudge() {
    if (closed || live) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    connect();
  }

  /** Fetch the state once, whatever the socket says. */
  async function refresh() {
    const at = pushed;
    const res = await o.api.get(o.statePath, o.credential);
    if (res.ok && !closed && at === pushed) o.onView(res.value);
    return res.ok;
  }
}
