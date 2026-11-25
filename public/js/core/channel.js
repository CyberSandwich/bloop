// Live updates for one credential, screen or phone (docs/architecture.md section 7). The credential travels in the
// first frame, never in the URL.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {ChannelOptions, SocketLike} from "../types.js" */
import {
  BLOCKED_PROBE_MS,
  COALESCE_MS,
  CONNECT_TIMEOUT_MS,
  DOWN_CONFIRM_MS,
  MISSED_PINGS,
  PING_MS,
  PROBE_MS,
  pollDelay,
  reconnectDelay,
  shouldPoll,
} from "./timing.js";

/** Errors after which the credential is dead and retrying is pointless. */
export const FATAL = /** @type {ReadonlySet<ErrorCode>} */ (
  new Set(["unauthorized", "pairing_invalid", "screen_gone"])
);

/** A refused read: dead drops the credential; the rest retry. @param {ErrorCode} code */
export const refusal = (code) =>
  code === "offline" || code === "service_down" ? "offline" : FATAL.has(code) ? "dead" : "retry";

/** The tab's memory that its network swallows the socket; not a `bloop.` key, so a session's end keeps it. */
const BLOCKED_KEY = "ws";

/**
 * Whether a `service_down` answer is the second in a row within DOWN_CONFIRM_MS: one 5xx is not yet "bloop isn't
 * responding". Any other answer resets it.
 * @returns {(down: boolean, now?: number) => boolean}
 */
export function downGate() {
  let last = -Infinity;
  return (down, now = Date.now()) => {
    if (!down) {
      last = -Infinity;
      return false;
    }
    const confirmed = now - last <= DOWN_CONFIRM_MS;
    last = now;
    return confirmed;
  };
}

/** @typedef {{t: string, [key: string]: unknown}} Frame */

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
  /** @type {ReturnType<typeof setTimeout> | null} */
  let connectTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let probeTimer = null;
  let lastHeard = 0;
  let pingedAt = 0;
  let missed = 0;
  /** State frames seen: a read older than a push is stale. */
  let pushed = 0;
  /** The last view's state: how often a poll is worth making. */
  let lastState = "";
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sendTimer = null;
  /** Frames sent inside the window, the latest of each type. @type {Map<string, Frame>} */
  const pending = new Map();
  const gate = downGate();
  const hidden = o.hidden ?? (() => /** @type {any} */ (globalThis).document?.hidden === true);
  const memory = o.storage === undefined ? safeSession() : o.storage;

  /** @returns {Pick<Storage, "getItem" | "setItem" | "removeItem"> | null} */
  function safeSession() {
    try {
      return globalThis.sessionStorage ?? null;
    } catch {
      return null;
    }
  }
  const blocked = () => {
    try {
      return memory?.getItem(BLOCKED_KEY) === "blocked";
    } catch {
      return false;
    }
  };
  const remember = (/** @type {boolean} */ on) => {
    try {
      if (on) memory?.setItem(BLOCKED_KEY, "blocked");
      else memory?.removeItem(BLOCKED_KEY);
    } catch {
      // storage blocked: the next screen probes first
    }
  };

  const clear = () => {
    for (const t of [retryTimer, pollTimer, connectTimer, probeTimer]) if (t) clearTimeout(t);
    if (pingTimer) clearInterval(pingTimer);
    if (sendTimer) clearTimeout(sendTimer);
    retryTimer = pollTimer = pingTimer = connectTimer = probeTimer = sendTimer = null;
    pending.clear();
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
    let retryAfter = 0;
    if (res.ok) {
      pollFailures = 0;
      gate(false);
      lastState = res.value?.state ?? lastState;
      o.onLink("ok");
      o.onView(res.value);
    } else if (FATAL.has(res.error)) {
      stop();
      o.onError(res.error);
      return;
    } else {
      pollFailures += 1;
      retryAfter = res.retryAfter ?? 0;
      if (res.error === "offline") o.onLink("offline");
      else if (res.error === "network_blocked") o.onLink("blocked");
      else if (gate(res.error === "service_down")) o.onLink("down");
    }
    pollTimer = setTimeout(poll, pollDelay(pollFailures, lastState, hidden(), retryAfter));
  }

  /** Polls now, and remembers it: this tab's next screen polls from its first second and probes the socket by the minute. */
  function startPolling() {
    remember(true);
    if (pollTimer || closed || live) return;
    pollTimer = setTimeout(poll, 0);
  }

  function lost() {
    if (closed) return;
    live = false;
    for (const t of [connectTimer, probeTimer]) if (t) clearTimeout(t);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = connectTimer = probeTimer = null;
    socket = null;
    pending.clear();
    failures += 1;
    if (shouldPoll(failures)) startPolling();
    retryTimer = setTimeout(connect, blocked() ? BLOCKED_PROBE_MS : reconnectDelay(failures));
  }

  function connect() {
    retryTimer = null;
    if (closed || socket) return;
    const ws = o.connect(o.url);
    socket = ws;
    ws.onopen = () => {
      lastHeard = Date.now();
      pingedAt = 0;
      missed = 0;
      ws.send(JSON.stringify({ v: 1, t: "hello", [o.helloKey]: o.credential }));
      // Two pings in a row with no frame back close it; a hidden tab's timers are throttled, so it is not judged.
      pingTimer = setInterval(() => {
        if (hidden()) missed = 0;
        else if (pingedAt && lastHeard < pingedAt) missed += 1;
        else missed = 0;
        if (missed >= MISSED_PINGS) return ws.close();
        pingedAt = Date.now();
        ws.send(JSON.stringify({ v: 1, t: "ping" }));
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
        for (const t of [connectTimer, probeTimer]) if (t) clearTimeout(t);
        connectTimer = probeTimer = null;
        remember(false);
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

  // A tab that already found its socket blocked polls from the first second and tries the socket once a minute.
  if (blocked()) {
    startPolling();
    retryTimer = setTimeout(connect, BLOCKED_PROBE_MS);
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
    isLive: () => live,
    nudge,
    refresh,
    /**
     * The tab is visible again. A live socket is pinged when it has been quiet; one that is down reconnects, and its
     * hello carries the state (no read), or, polling, the next poll comes now.
     */
    wake() {
      if (live) return probe();
      nudge();
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, 0);
      }
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

  /** A socket that reports open after a long quiet may be dead (a suspended tab): ask, and replace it if nothing answers. */
  function probe() {
    const ws = socket;
    if (closed || !live || !ws || probeTimer || Date.now() - lastHeard <= PING_MS) return;
    const asked = Date.now();
    ws.send(JSON.stringify({ v: 1, t: "ping" }));
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (socket !== ws || lastHeard >= asked) return;
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      ws.close();
      lost();
      nudge();
    }, PROBE_MS);
  }

  /** Fetch the state once, whatever the socket says. */
  async function refresh() {
    const at = pushed;
    const res = await o.api.get(o.statePath, o.credential);
    if (res.ok && !closed && at === pushed) o.onView(res.value);
    return res.ok;
  }
}
