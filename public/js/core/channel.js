// Live updates for one credential, screen or phone (docs/architecture.md section 7). The credential travels in the
// first frame, never in the URL.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {ChannelOptions, SocketLike} from "../types.js" */
import { CONNECT_TIMEOUT_MS, PING_MS, pollDelay, reconnectDelay, SILENCE_MS, shouldPoll } from "./timing.js";

/** Errors after which the credential is dead and retrying is pointless. */
export const FATAL = /** @type {ReadonlySet<ErrorCode>} */ (
  new Set(["unauthorized", "pairing_invalid", "screen_gone"])
);

/** A refused read: dead drops the credential; the rest retry. @param {ErrorCode} code */
export const refusal = (code) =>
  code === "offline" || code === "service_down" ? "offline" : FATAL.has(code) ? "dead" : "retry";

/** @param {ChannelOptions} o */
export function openChannel(o) {
  let closed = false;
  let failures = 0;
  let pollFailures = 0;
  let live = false;
  /** @type {SocketLike | null} */
  let socket = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pollTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pingTimer = null;
  let lastHeard = 0;
  /** State frames seen: a read older than a push is stale. */
  let pushed = 0;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let connectTimer = null;

  const clear = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (connectTimer) clearTimeout(connectTimer);
    retryTimer = pollTimer = pingTimer = connectTimer = null;
  };

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollFailures = 0;
  }

  async function poll() {
    pollTimer = null;
    if (closed || live) return;
    const res = await o.api.get(o.statePath, o.credential);
    if (closed || live) return;
    if (res.ok) {
      pollFailures = 0;
      o.onLink("ok");
      o.onView(res.value);
    } else if (FATAL.has(res.error)) {
      stop();
      o.onError(res.error);
      return;
    } else {
      pollFailures += 1;
      o.onLink(res.error === "offline" ? "offline" : res.error === "network_blocked" ? "blocked" : "down");
    }
    pollTimer = setTimeout(poll, pollDelay(pollFailures));
  }

  function startPolling() {
    if (pollTimer || closed || live) return;
    pollTimer = setTimeout(poll, 0);
  }

  function lost() {
    if (closed) return;
    live = false;
    if (pingTimer) clearInterval(pingTimer);
    if (connectTimer) clearTimeout(connectTimer);
    pingTimer = connectTimer = null;
    socket = null;
    failures += 1;
    if (shouldPoll(failures)) startPolling();
    retryTimer = setTimeout(connect, reconnectDelay(failures));
  }

  function connect() {
    retryTimer = null;
    if (closed || socket) return;
    const ws = o.connect(o.url);
    socket = ws;
    ws.onopen = () => {
      lastHeard = Date.now();
      ws.send(JSON.stringify({ v: 1, t: "hello", [o.helloKey]: o.credential }));
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > SILENCE_MS) ws.close();
        else ws.send(JSON.stringify({ v: 1, t: "ping" }));
      }, PING_MS);
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
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        stopPolling();
        o.onLink("ok");
      }
      if (frame.t === "state") {
        pushed += 1;
        o.onView(frame.view);
      } else if (frame.t === "error") {
        if (FATAL.has(frame.code)) stop();
        o.onError(frame.code);
      } else o.onFrame?.(frame);
    };
    const gone = () => {
      if (socket !== ws) return;
      ws.onclose = ws.onerror = null;
      lost();
    };
    ws.onclose = gone;
    ws.onerror = gone;
    // A proxy that holds the upgrade (or the first frame) fires neither close nor error: poll now, retry the socket.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (socket !== ws || live) return;
      startPolling();
      ws.close();
      gone();
    }, CONNECT_TIMEOUT_MS);
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

  connect();

  return {
    /** @param {object} frame */
    send(frame) {
      if (live && socket) socket.send(JSON.stringify({ v: 1, ...frame }));
      return live;
    },
    isLive: () => live,
    nudge,
    refresh,
    /** The tab is visible again: its timers may have slept through pushes and deadlines, so read the state too. */
    wake() {
      nudge();
      void refresh();
    },
    stop,
  };

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
