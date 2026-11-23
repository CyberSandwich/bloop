// Live updates for one credential: a WebSocket with reconnect and backoff, and the state route
// polled every 3 s once 3 reconnects have failed (docs/architecture.md section 7). The credential
// travels in the first frame, never in the URL. Works for both the screen and the phone.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
import { PING_MS, pollDelay, reconnectDelay, SILENCE_MS, shouldPoll } from "./timing.js";

/** Errors after which the credential is dead and retrying is pointless. */
export const FATAL = /** @type {ReadonlySet<ErrorCode>} */ (
  new Set(["unauthorized", "pairing_invalid", "screen_gone"])
);

/**
 * @typedef {object} SocketLike
 * @property {(data: string) => void} send
 * @property {() => void} close
 * @property {((e: any) => void) | null} onopen
 * @property {((e: any) => void) | null} onmessage
 * @property {((e: any) => void) | null} onclose
 * @property {((e: any) => void) | null} onerror
 */

/**
 * @typedef {object} ChannelOptions
 * @property {string} url full ws(s) URL, carrying only the non-secret ref
 * @property {string} statePath polling route
 * @property {string} credential sid or pid
 * @property {"sid" | "pid"} helloKey
 * @property {import("./api.js").Api} api
 * @property {(url: string) => SocketLike} connect
 * @property {(view: any) => void} onView
 * @property {(code: ErrorCode, view?: any) => void} onError a pushed error frame, or a fatal poll error
 * @property {(frame: any) => void} [onFrame] `open` and any other frame the page handles
 * @property {(link: "ok" | "offline" | "down") => void} onLink
 */

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

  const clear = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
    retryTimer = pollTimer = pingTimer = null;
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
      o.onLink(res.error === "offline" ? "offline" : "down");
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
    pingTimer = null;
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
        stopPolling();
        o.onLink("ok");
      }
      if (frame.t === "state") o.onView(frame.view);
      else if (frame.t === "error") {
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
    /** Retry now: the tab became visible again, or the network came back. */
    nudge() {
      if (closed || live) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      connect();
    },
    /** Fetch the state once, whatever the socket says. */
    async refresh() {
      const res = await o.api.get(o.statePath, o.credential);
      if (res.ok) o.onView(res.value);
      return res.ok;
    },
    stop,
  };
}
