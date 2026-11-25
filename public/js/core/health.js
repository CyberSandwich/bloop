// Whether an open socket is still alive, loaded once one opens (the first ping is PING_MS away, so it is not in the
// first load). Rules: docs/architecture.md section 7.
import { SILENCE_MS } from "./timing.js";

export const PING_MS = 25_000;
/** A socket quiet for longer than PING_MS when the tab shows again is asked; no frame back in this long replaces it. */
export const PROBE_MS = 3000;
/** This many pings in a row with no frame back drop a visible tab's socket. */
export const MISSED_PINGS = 2;

/** @import {SocketLike} from "../types.js" */

/**
 * Pings the socket and gives it up when it stops answering.
 * @param {{
 *   ws: SocketLike,
 *   heard: () => number,
 *   hidden: () => boolean,
 *   drop: (ws: SocketLike) => void,
 *   replace: (ws: SocketLike) => void,
 * }} h `heard`: when a frame last came; `replace`: drop it and reconnect now
 */
export function watch(h) {
  const ping = () => h.ws.send('{"v":1,"t":"ping"}');
  let pingedAt = 0;
  let missed = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let probing = null;
  // Two pings in a row with no frame back drop it. A hidden tab's timers are throttled, so it is judged by the longer
  // silence instead.
  const every = setInterval(() => {
    if (h.hidden()) {
      missed = 0;
      if (Date.now() - h.heard() > SILENCE_MS) return h.drop(h.ws);
    } else {
      missed = pingedAt && h.heard() < pingedAt ? missed + 1 : 0;
      if (missed >= MISSED_PINGS) return h.drop(h.ws);
    }
    pingedAt = Date.now();
    ping();
  }, PING_MS);

  return {
    stop() {
      clearInterval(every);
      if (probing) clearTimeout(probing);
    },
    /** A socket that reports open after a long quiet may be dead (a suspended tab): ask, and replace it if nothing answers. */
    probe() {
      if (probing || Date.now() - h.heard() <= PING_MS) return;
      const asked = Date.now();
      ping();
      probing = setTimeout(() => {
        probing = null;
        if (h.heard() < asked) h.replace(h.ws);
      }, PROBE_MS);
    },
  };
}
