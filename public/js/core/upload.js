// The upload engine: a queue of files, each fingerprinted, opened with POST /api/uploads and sent as multipart parts
// (docs/uploads.md for the wire, docs/ux/upload.md for what the person reads). No DOM: every browser effect comes
// through `deps`, so the unit tests drive it with fakes. XMLHttpRequest sends the parts because only it reports upload
// progress in every phone browser.
/** @import {Xhr} from "../types.js" */
import { createApi, isErrorCode } from "./api.js";

const KIB = 1024;
const MIB = KIB * KIB;
const SAMPLE_BYTES = 64 * KIB;
const SAMPLES = 16;
const MAX_PARTS = 10_000;
const MAX_URLS = 8;
const MAX_CONCURRENT = 4;
const FAST_MS = 10_000;
const STALL_MS = 30_000;
const PROBE_MS = 15_000;
const REMINT_MS = 60_000;
const DEFAULT_TTL_MS = 300_000;
const RETRY_MS = [1000, 3000, 9000];
// A Retry-After beyond this is a limit to report, not to wait out; no long timers (a hidden tab throttles them).
const MAX_WAIT_S = 120;
const MAX_429 = 5;
const MAX_BUSY = 5;
const MAX_ROUNDS = 5;
const MAX_REJECTED = 3;
// A request with no answer by then is the network; a complete may wait on the server's check.
const CALL_MS = 30_000;
const COMPLETE_MS = 120_000;
// The server's validation after complete: asked every 2 s, for 5 minutes.
const POLL_MS = 2000;
const MAX_POLLS = 150;
const ETA_AFTER_S = 5;
const ETA_MOVE = 0.2;
const ETA_WEIGHT = 0.2;

/** Ends a file's run: its state is already set. @type {{end: true}} */
const END = { end: true };

/**
 * @typedef {"queued" | "fingerprinting" | "starting" | "uploading" | "waiting" | "checking" | "saved" | "sent"
 *   | "refused" | "paused" | "canceled"} State
 * @typedef {{id: number, name: string, size: number, state: State, loaded: number, fraction: number,
 *   error?: string, view?: unknown, fileId?: string, fileStatus?: string, uploadId?: string}} FileSnap
 * @typedef {{files: FileSnap[], active: boolean, total: number, loaded: number, fraction: number,
 *   etaMs: number | null}} Batch
 * @typedef {{limit: number, fast: number}} Pace
 * @typedef {{at: number, bytes: number, rate: number, secs: number, est: number | null, estAt: number}} Eta
 * @typedef {{url: string, direct: boolean, expires: number}} PartUrl
 * @typedef {{status: number, body?: any, retryAfter?: number}} Answer
 * @typedef {{status: number, aborted?: boolean, etag?: string | null, ours?: boolean, body?: any,
 *   retryAfter?: number}} Put
 * @typedef {{request: (type: "screen") => Promise<{release: () => Promise<void>,
 *   addEventListener: (type: "release", fn: () => void) => void}>}} WakeLock
 * @typedef {{addEventListener: (type: string, fn: (e: any) => void) => void,
 *   removeEventListener: (type: string, fn: (e: any) => void) => void}} Events
 * @typedef {object} Deps
 * @property {typeof fetch} fetch
 * @property {() => Xhr} xhr
 * @property {() => number} now a clock that never goes back (performance.now)
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(timer: unknown) => void} clearTimeout
 * @property {() => string} uuid
 * @property {Pick<SubtleCrypto, "digest">} subtle
 * @property {Events & {location?: {origin: string}}} win online, offline, beforeunload; the page's origin
 * @property {Events & {visibilityState: string}} doc visibilitychange
 * @property {WakeLock | undefined} wakeLock
 * @property {((ms: number) => unknown) | undefined} vibrate
 */

/** @returns {Deps} the browser's, read when an uploader is made so a test can stub the globals first */
function browserDeps() {
  const g = /** @type {any} */ (globalThis);
  return {
    fetch: (...args) => g.fetch(...args),
    xhr: () => new g.XMLHttpRequest(),
    now: () => g.performance.now(),
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (timer) => g.clearTimeout(timer),
    uuid: () => g.crypto.randomUUID(),
    subtle: g.crypto.subtle,
    win: g,
    doc: g.document,
    wakeLock: g.navigator?.wakeLock,
    vibrate: g.navigator?.vibrate?.bind(g.navigator),
  };
}

/**
 * SHA-256 over the name, the size and 16 evenly spaced 64 KiB samples, the first and last included. No
 * `lastModified`: an iOS picker stamps each copy with the current time, which would break resuming.
 * @param {{name: string, size: number, slice: (start: number, end: number) => Blob}} file
 * @param {Deps["subtle"]} [subtle]
 * @returns {Promise<string>} 64 lowercase hex characters
 */
export async function fingerprint(file, subtle = globalThis.crypto.subtle) {
  const len = Math.min(SAMPLE_BYTES, file.size);
  /** @type {(string | Blob)[]} */
  const parts = [JSON.stringify([file.name, file.size])];
  for (let i = 0; i < SAMPLES; i++) {
    const at = Math.floor((i * (file.size - len)) / (SAMPLES - 1));
    parts.push(file.slice(at, at + len));
  }
  const digest = await subtle.digest("SHA-256", await new Blob(parts).arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Where each part starts and ends (end exclusive); part n is index n - 1. The last is the remainder.
 * @param {number} bytes
 * @param {number} partBytes
 * @returns {[number, number][]}
 */
export function planParts(bytes, partBytes) {
  /** @type {[number, number][]} */
  const plan = [];
  for (let start = 0; start < bytes; start += partBytes) plan.push([start, Math.min(bytes, start + partBytes)]);
  return plan;
}

/** Concurrency starts at 2, gains one (to 4) after 2 parts in a row finish under 10 s, and drops to 1 on a failure. @type {Pace} */
export const PACE = { limit: 2, fast: 0 };

/**
 * @param {Pace} pace
 * @param {{ok: boolean, ms: number}} part the part that just ended
 * @returns {Pace}
 */
export function nextConcurrency(pace, part) {
  if (!part.ok) return { limit: 1, fast: 0 };
  const fast = part.ms < FAST_MS ? pace.fast + 1 : 0;
  return fast >= 2 && pace.limit < MAX_CONCURRENT ? { limit: pace.limit + 1, fast: 0 } : { limit: pace.limit, fast };
}

/** @returns {Eta} */
export const etaStart = () => ({ at: -1, bytes: 0, rate: 0, secs: 0, est: null, estAt: 0 });

/** @param {Eta} s @param {number} now @returns {number | null} the time left as shown, counting down between changes */
export const etaLeft = (s, now) => (s.est === null ? null : Math.max(0, s.est - (now - s.estAt)));

/**
 * The time left (UP-10). Throughput is an EWMA of the bytes moved per second, 0.2 for the newest second; the estimate
 * is bytes left over that mean; it shows after 5 s of samples and moves only when it differs from what is shown by
 * 20 percent or more.
 * @param {Eta} s
 * @param {number} loaded bytes moved so far (confirmed plus in flight, never going back)
 * @param {number} total
 * @param {number} now ms
 * @returns {Eta}
 */
export function etaOf(s, loaded, total, now) {
  if (s.at < 0) return { ...s, at: now, bytes: loaded };
  const dt = now - s.at;
  if (dt < 1000) return s;
  // A file leaving the batch lowers the bytes counted; that is no negative throughput.
  const rate = (Math.max(0, loaded - s.bytes) * 1000) / dt;
  const weight = s.secs ? 1 - (1 - ETA_WEIGHT) ** (dt / 1000) : 1;
  const mean = s.secs ? weight * rate + (1 - weight) * s.rate : rate;
  const next = { ...s, at: now, bytes: loaded, rate: mean, secs: s.secs + dt / 1000 };
  if (next.secs < ETA_AFTER_S || mean <= 0) return next;
  const est = ((total - loaded) * 1000) / mean;
  const shown = etaLeft(s, now);
  return shown === null || Math.abs(est - shown) >= ETA_MOVE * shown ? { ...next, est, estAt: now } : next;
}

/** @param {number} ms @returns {string} whole minutes rounded up, so it never counts by seconds */
export const etaLabel = (ms) => (ms < 60_000 ? "Under a minute left" : `${Math.ceil(ms / 60_000)} min left`);

/**
 * "34 of 88 MB": both numbers in the total's unit, one decimal under 10, whole above (UX: units). The sent share
 * rounds down, so it never reads ahead of the bytes.
 * @param {number} loaded
 * @param {number} total
 */
export function formatBytes(loaded, total) {
  const unit = total < MIB ? KIB : total < KIB * MIB ? MIB : KIB * MIB;
  const name = unit === KIB ? "KB" : unit === MIB ? "MB" : "GB";
  const scaled = total / unit;
  if (Math.round(scaled * 10) >= 100 || unit === KIB)
    return `${Math.floor(loaded / unit)} of ${Math.max(1, Math.round(scaled))} ${name}`;
  return `${(Math.floor((loaded / unit) * 10) / 10).toFixed(1)} of ${scaled.toFixed(1)} ${name}`;
}

/** @param {string | null | undefined} header @returns {number | undefined} whole seconds (an HTTP date is not honored) */
const seconds = (header) => {
  const n = Number.parseInt(header ?? "", 10);
  return n > 0 ? n : undefined;
};

/**
 * @typedef {object} Rec one file's run
 * @property {number} id
 * @property {{name: string, size: number, slice: (s: number, e: number) => Blob} | null} file null while paused
 * @property {string} name
 * @property {number} size
 * @property {State} state
 * @property {string} key the Idempotency-Key: one per intent, kept across its retries
 * @property {string} [fp]
 * @property {string} [uploadId]
 * @property {string} [pausedId] the open upload this file was chosen to finish
 * @property {string} [error]
 * @property {unknown} [view]
 * @property {string} [fileId]
 * @property {string} [fileStatus]
 * @property {"direct" | "proxy"} mode
 * @property {[number, number][]} plan
 * @property {Set<number>} done parts the server confirmed
 * @property {{n: number, etag: string, bytes: number} | null} rider the last direct part, confirmed by complete
 * @property {Map<number, PartUrl>} urls
 * @property {Map<number, number>} inflight bytes the XHRs of the parts on the wire have sent
 * @property {Set<number>} sending the parts a task has taken
 * @property {Set<Xhr>} xhrs
 * @property {Pace} pace
 * @property {boolean} directOk a direct part has succeeded
 * @property {number} netErrs network errors on direct PUTs before that
 * @property {number} shown bytes shown: never goes back
 * @property {boolean} stopped ended: canceled, refused or disposed
 * @property {boolean} halted the parts loop stops starting parts and drains
 * @property {number} outages tasks waiting for the connection
 * @property {Set<() => void>} nudges wake a waiting task
 * @property {Set<() => void>} ends cut a pause short when the file ends
 * @property {State} before the state a wait returns to
 * @property {number} rejected 4xx answers to direct PUTs since one succeeded
 * @property {Promise<void> | null} minting
 */

/**
 * @param {object} args
 * @param {"library" | "guest"} args.kind a guest's requests carry its pairing credential; the library's, its cookie
 * @param {string} [args.pid] the guest credential
 * @param {(batch: Batch) => void} args.onChange a plain snapshot after every change
 * @param {Partial<Deps>} [args.deps] fakes, for the unit tests
 */
export function createUploader({ kind, pid, onChange, deps }) {
  const d = { ...browserDeps(), ...deps };
  const api = createApi({ fetch: d.fetch });
  const guest = kind === "guest";
  /** @type {Rec[]} */
  let records = [];
  let nextId = 1;
  let eta = etaStart();
  let moving = false;
  let disposed = false;
  let draining = false;
  /** @type {Awaited<ReturnType<WakeLock["request"]>> | null} */
  let lock = null;
  let locking = false;

  /** @param {Rec} r @param {State} state */
  const set = (r, state) => {
    r.state = state;
    emit();
  };

  /** @param {Rec} r @param {number} n */
  const span = (r, n) => {
    const [start, end] = /** @type {[number, number]} */ (r.plan[n - 1]);
    return end - start;
  };
  /** @param {Rec} r the fill: confirmed plus in flight, never going back (UP-11) */
  const bump = (r) => {
    let raw = r.rider ? r.rider.bytes : 0;
    for (const n of r.done) raw += span(r, n);
    for (const bytes of r.inflight.values()) raw += bytes;
    r.shown = Math.max(r.shown, Math.min(raw, r.size));
    emit();
  };

  /** @param {Rec} r */
  const saved = (r) => r.state === "saved" || r.state === "sent";
  /** The file's run is over, one way or another; a paused row waits for a file. @param {Rec} r */
  const ended = (r) => saved(r) || r.state === "refused" || r.state === "paused" || r.state === "canceled";
  /** @param {Rec} r @returns {number} bytes counted toward the batch */
  const loadedOf = (r) => (saved(r) ? r.size : r.shown);
  /** @param {Rec} r @returns {FileSnap} */
  const snap = (r) => {
    const done = saved(r);
    /** @type {FileSnap} */
    const out = {
      id: r.id,
      name: r.name,
      size: r.size,
      state: r.state,
      loaded: loadedOf(r),
      fraction: done ? 1 : r.size ? Math.min(0.99, r.shown / r.size) : 0,
    };
    if (r.error !== undefined) out.error = r.error;
    if (r.view !== undefined) out.view = r.view;
    if (r.fileId !== undefined) out.fileId = r.fileId;
    if (r.fileStatus !== undefined) out.fileStatus = r.fileStatus;
    if (r.uploadId !== undefined) out.uploadId = r.uploadId;
    return out;
  };

  /** The batch is every file but a paused row and the ones that left it. @param {Rec} r */
  const inBatch = (r) => r.state !== "paused" && r.state !== "refused" && r.state !== "canceled";

  function emit() {
    if (disposed) return;
    const members = records.filter(inBatch);
    const total = members.reduce((sum, r) => sum + r.size, 0);
    const loaded = members.reduce((sum, r) => sum + loadedOf(r), 0);
    const active = !records.every(ended);
    const nowMoving = records.some((r) => r.state === "uploading");
    if (nowMoving) eta = etaOf(eta, loaded, total, d.now());
    if (nowMoving !== moving) {
      moving = nowMoving;
      effects();
    }
    onChange({
      files: records.map(snap),
      active,
      total,
      loaded,
      fraction: total && active ? Math.min(0.99, loaded / total) : total ? 1 : 0,
      etaMs: moving ? etaLeft(eta, d.now()) : null,
    });
  }

  /** @param {{preventDefault: () => void, returnValue?: unknown}} e */
  const leaving = (e) => {
    e.preventDefault();
    e.returnValue = "";
  };
  const release = () => {
    const held = lock;
    lock = null;
    held?.release().catch(() => {});
  };
  async function hold() {
    if (lock || locking || !d.wakeLock) return;
    locking = true;
    try {
      const held = await d.wakeLock.request("screen");
      lock = held;
      held.addEventListener("release", () => {
        if (lock === held) lock = null;
      });
    } catch {
      // refused (low battery, hidden page): the waiting state covers a lock screen
    }
    locking = false;
    if (!moving || disposed) release();
  }
  /** Bytes are moving: hold the screen and prompt before the page goes; otherwise let go of both. */
  function effects() {
    if (moving) {
      d.win.addEventListener("beforeunload", leaving);
      void hold();
    } else {
      d.win.removeEventListener("beforeunload", leaving);
      release();
    }
  }

  /** Waits ; the file ending cuts it short, and so does an online or visible page when . @param {Rec} r @param {number} ms @param {boolean} [wakeable] */
  const pause = (r, ms, wakeable = false) =>
    new Promise((resolve) => {
      const done = () => {
        d.clearTimeout(timer);
        r.ends.delete(done);
        r.nudges.delete(done);
        resolve(undefined);
      };
      const timer = d.setTimeout(done, ms);
      r.ends.add(done);
      if (wakeable) r.nudges.add(done);
    });

  /**
   * Ends a file's run in a state. Whatever it still has on the wire is cut.
   * @param {Rec} r @param {State} state @param {Partial<Rec>} [more]
   */
  function finishRec(r, state, more = {}) {
    Object.assign(r, more);
    r.stopped = true;
    for (const x of r.xhrs) x.abort();
    r.inflight.clear();
    for (const end of [...r.ends]) end();
    set(r, state);
  }
  /** @param {Rec} r @param {string} code @returns {never} */
  function refuse(r, code) {
    finishRec(r, "refused", { error: guest && !isErrorCode(code) ? "bad_request" : code });
    throw END;
  }
  /** The row is gone: the library keeps the file's place as paused; a guest's send ends. @param {Rec} r @returns {never} */
  function gone(r) {
    if (guest) return refuse(r, "upload_aborted");
    finishRec(r, "paused", { file: null });
    throw END;
  }

  /**
   * @param {"GET" | "POST" | "DELETE"} method @param {string} path @param {unknown} [body]
   * @param {Record<string, string>} [headers]
   * @param {number} [ms] how long it may take
   * @returns {Promise<Answer>} status 0 for the network, or for a 2xx that is not bloop's (a filter's page, REL-03)
   */
  async function call(method, path, body, headers = {}, ms = CALL_MS) {
    // A half-open connection never answers: past the limit the request is the network.
    const res = await api.call(method, path, { auth: guest ? pid : null, body, headers, timeout: ms });
    if (res.ok) return { status: 200, body: res.value };
    return {
      status: res.status ?? 0,
      body: { code: res.code },
      ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}),
    };
  }

  /** @param {string} id @returns {string} */
  const pathOf = (id) => `/api/uploads/${encodeURIComponent(id)}`;
  /** @param {Rec} r @returns {string} */
  const base = (r) => pathOf(/** @type {string} */ (r.uploadId));
  /** @param {Rec} r @param {number} n */
  const proxyPath = (r, n) => `${base(r)}/parts/${n}`;
  /** @param {{body?: any}} res @returns {string} the code an answer carries, or a bad request */
  const codeOf = (res) => (typeof res.body?.code === "string" ? res.body.code : "bad_request");

  /** A 429: wait out its Retry-After, or refuse when it asks for too long or comes too often. @param {Rec} r @param {Answer} res @param {number} times 429s so far in this request */
  async function wait429(r, res, times) {
    const wait = res.retryAfter && res.retryAfter > 0 ? res.retryAfter : 5;
    if (wait > MAX_WAIT_S || times > MAX_429) refuse(r, res.body?.code ?? "rate_limited");
    await pause(r, wait * 1000);
    if (r.stopped) throw END;
  }

  /** Retry after 1, 3 and 9 s on the network or a 5xx; wait out a 429. Null: gave up. @param {Rec} r @param {() => Promise<Answer>} send @param {boolean} [keep] hand back the answer of a file that ended meanwhile */
  async function tryRequest(r, send, keep = false) {
    let tries = 0;
    let limited = 0;
    for (;;) {
      const res = await send();
      if (r.stopped) {
        if (keep) return res;
        throw END;
      }
      if (res.status === 429) {
        await wait429(r, res, ++limited);
        continue;
      }
      if (res.status !== 0 && res.status < 500) return res;
      if (tries >= RETRY_MS.length) return null;
      await pause(r, RETRY_MS[tries++] ?? 0);
      if (r.stopped) throw END;
    }
  }
  /** One request that outlives the network: retried, then waiting until the connection is back, then again. @param {Rec} r @param {() => Promise<Answer>} send @param {boolean} [keep] */
  async function ask(r, send, keep = false) {
    for (;;) {
      const res = await tryRequest(r, send, keep);
      if (res) return res;
      await outage(r);
    }
  }

  /** @param {Rec} r a 4xx that is no answer to the request: its code, or a bad request @param {Answer} res @returns {never} */
  function failed(r, res) {
    if (res.status === 404 || res.status === 410) return gone(r);
    return refuse(r, codeOf(res));
  }

  /** What the server holds: the parts it has. False when it cannot be asked now. @param {Rec} r @returns {Promise<boolean>} */
  async function sync(r) {
    if (!r.uploadId) return true;
    const res = await call("GET", base(r));
    if (r.stopped) throw END;
    if (res.status === 0 || res.status === 429 || res.status >= 500) return false;
    if (res.status !== 200) return failed(r, res);
    if (res.body?.state === "aborted") return gone(r);
    for (const n of Array.isArray(res.body?.done) ? res.body.done : [])
      if (Number.isInteger(n) && n >= 1 && n <= r.plan.length) r.done.add(n);
    return true;
  }

  /** Waiting: until `online`, the page visible again, or a 15 s probe; then what the server holds. @param {Rec} r */
  async function outage(r) {
    if (r.outages++ === 0) {
      r.before = r.state;
      if (r.state !== "checking") set(r, "waiting");
    }
    // The time left counted down while it was out; it is estimated afresh from the next samples.
    eta = { ...eta, at: -1, est: null };
    try {
      do {
        await pause(r, PROBE_MS, true);
        if (r.stopped) throw END;
      } while (!(await sync(r)));
    } finally {
      if (--r.outages === 0 && r.state === "waiting") set(r, r.before);
    }
  }

  /** @param {Rec} r @returns {number[]} the parts still to send, in order */
  const gaps = (r) => r.plan.flatMap((_, i) => (r.done.has(i + 1) || r.rider?.n === i + 1 ? [] : [i + 1]));

  /**
   * Keeps a part's URL for the next send. A direct URL must be https; a proxy URL is the one path the part has, so
   * what the server sent is checked against it and never used as given.
   * @param {Rec} r @param {unknown} list @param {unknown} ttl
   */
  function keepUrls(r, list, ttl) {
    const at = d.now();
    const life = typeof ttl === "number" && ttl > 0 ? ttl : DEFAULT_TTL_MS;
    for (const item of Array.isArray(list) ? list : []) {
      const n = item?.n;
      if (!Number.isInteger(n) || n < 1 || n > r.plan.length || typeof item.url !== "string") continue;
      if (r.mode === "proxy") {
        if (item.url === proxyPath(r, n))
          r.urls.set(n, { url: item.url, direct: false, expires: Number.POSITIVE_INFINITY });
        continue;
      }
      try {
        // Another host than bloop's: this page's cookies must not ride on a part.
        const { protocol, origin } = new URL(item.url);
        if (protocol === "https:" && origin !== d.win.location?.origin)
          r.urls.set(n, { url: item.url, direct: true, expires: at + life });
      } catch {
        // not a URL: never used
      }
    }
  }

  /** @param {Rec} r @param {number} n @returns {boolean} */
  const fresh = (r, n) => {
    const u = r.urls.get(n);
    return !!u && d.now() < u.expires - REMINT_MS;
  };

  /** Mints the next batch of up to 8 pending parts, the wanted one first. @param {Rec} r @param {number} n */
  async function mint(r, n) {
    const want = [n];
    for (const m of gaps(r)) if (want.length < MAX_URLS && m !== n && !fresh(r, m) && !r.sending.has(m)) want.push(m);
    const mode = r.mode;
    const res = await ask(r, () =>
      call("POST", `${base(r)}/urls`, mode === "proxy" ? { parts: want, mode } : { parts: want }),
    );
    if (res.status !== 200) return failed(r, res);
    // The upload went to proxy while this was on the wire: its direct URLs are no use, and the part mints again.
    if (r.mode !== mode) return;
    keepUrls(r, res.body?.urls, res.body?.ttlMs);
    if (!r.urls.has(n)) refuse(r, "service_down");
  }
  /** @param {Rec} r @param {number} n @returns {Promise<PartUrl>} */
  async function urlFor(r, n) {
    for (;;) {
      if (fresh(r, n)) return /** @type {PartUrl} */ (r.urls.get(n));
      if (r.minting) {
        await r.minting;
        continue;
      }
      r.minting = mint(r, n).finally(() => {
        r.minting = null;
      });
      await r.minting;
    }
  }

  /** @param {Rec} r @param {number} n @param {PartUrl} u @param {Blob} blob @returns {Promise<Put>} */
  function put(r, n, u, blob) {
    return new Promise((resolve) => {
      const x = d.xhr();
      /** @type {unknown} */
      let timer = null;
      let stalled = false;
      const arm = () => {
        d.clearTimeout(timer);
        timer = d.setTimeout(() => {
          stalled = true;
          x.abort();
        }, STALL_MS);
      };
      /** @param {Put} out */
      const end = (out) => {
        d.clearTimeout(timer);
        r.xhrs.delete(x);
        resolve(out);
      };
      x.open("PUT", u.url);
      // The credential goes to bloop only: a direct URL is another host and carries its own signature.
      if (!u.direct) {
        if (guest) x.setRequestHeader("Authorization", `Bearer ${pid}`);
        x.setRequestHeader("Content-Type", "application/octet-stream");
      }
      x.upload.onprogress = (e) => {
        arm();
        r.inflight.set(n, Math.min(e.loaded, blob.size));
        bump(r);
      };
      x.onerror = () => end({ status: 0 });
      x.onabort = () => end({ status: 0, aborted: !stalled });
      x.onload = () => {
        const retryAfter = seconds(x.getResponseHeader("Retry-After"));
        /** @type {any} */
        let body = null;
        try {
          body = JSON.parse(x.responseText);
        } catch {
          // storage answers XML: only the status and the ETag matter
        }
        end({
          status: x.status,
          etag: x.getResponseHeader("ETag"),
          ours: x.getResponseHeader("X-Bloop") === "1",
          body,
          ...(retryAfter ? { retryAfter } : {}),
        });
      };
      r.xhrs.add(x);
      arm();
      x.send(blob);
    });
  }

  /** @param {Rec} r a direct upload whose storage host cannot be reached goes through bloop for the rest */
  function toProxy(r) {
    r.mode = "proxy";
    r.urls.clear();
  }

  /** One part to its end: sent, confirmed, or the loop halted. @param {Rec} r @param {number} n */
  async function sendPart(r, n) {
    const [start, end] = /** @type {[number, number]} */ (r.plan[n - 1]);
    let tries = 0;
    let limited = 0;
    let reminted = false;
    for (;;) {
      if (r.stopped) throw END;
      if (r.halted) return;
      const u = await urlFor(r, n);
      const began = d.now();
      const res = await put(r, n, u, /** @type {NonNullable<Rec["file"]>} */ (r.file).slice(start, end));
      r.inflight.delete(n);
      if (r.stopped) throw END;
      if (res.aborted) {
        r.halted = true;
        return;
      }
      // A direct part is proven by the ETag the storage host exposes (CORS), a proxied one by bloop's marked JSON;
      // a 2xx without it is the network (a filter's page, or a host that does not answer as ours).
      const ok = res.status >= 200 && res.status < 300;
      const etag = res.etag ?? "";
      const status = ok && !(u.direct ? etag : res.ours) ? 0 : res.status;
      if (ok && status !== 0) {
        if (!u.direct) r.done.add(n);
        else if (r.done.size + 1 === r.plan.length) r.rider = { n, etag, bytes: end - start };
        else await confirm(r, n, etag, end - start);
        if (u.direct) {
          r.directOk = true;
          r.rejected = 0;
        }
        r.pace = nextConcurrency(r.pace, { ok: true, ms: d.now() - began });
        bump(r);
        return;
      }
      bump(r);
      if (status === 404 || status === 410) return gone(r);
      if (status === 429) {
        await wait429(r, res, ++limited);
        continue;
      }
      if (!reminted && u.direct && (status === 403 || (status === 0 && d.now() >= u.expires))) {
        // An expired or badly signed URL is minted again once, and is not a failure.
        reminted = true;
        r.urls.delete(n);
        continue;
      }
      // bloop's own answer to a part is final; a storage host's 4xx is retried a few times, then it is refused.
      if (status >= 400 && status < 500 && (!u.direct || ++r.rejected > MAX_REJECTED)) return refuse(r, codeOf(res));
      r.pace = nextConcurrency(r.pace, { ok: false, ms: 0 });
      // A host that does not answer, or answers 403 to a fresh URL, is a proxy refusing it: go through bloop.
      if (u.direct && (status === 0 || status === 403) && !r.directOk && ++r.netErrs >= 2) {
        toProxy(r);
        continue;
      }
      if (tries >= RETRY_MS.length) {
        r.halted = true;
        return;
      }
      await pause(r, RETRY_MS[tries++] ?? 0);
    }
  }

  /** A direct part is the server's once it says so. @param {Rec} r @param {number} n @param {string} etag @param {number} bytes */
  async function confirm(r, n, etag, bytes) {
    const res = await ask(r, () => call("POST", `${base(r)}/parts/${n}/done`, { etag, bytes }));
    if (res.status !== 200) return failed(r, res);
    r.done.add(n);
  }

  /** @param {Rec} r @param {number[]} todo parts to send, in order */
  function pump(r, todo) {
    const queue = [...todo];
    /** @type {Set<Promise<void>>} */
    const live = new Set();
    return new Promise((resolve) => {
      const next = () => {
        for (;;) {
          const left = queue.length + live.size;
          const room = (left < 2 ? 1 : r.pace.limit) - live.size;
          const n = queue[0];
          if (r.halted || r.stopped || room <= 0 || n === undefined) break;
          queue.shift();
          r.sending.add(n);
          const task = sendPart(r, n).then(
            () => {},
            (e) => {
              // An ended file already has its state; anything else is a bug, shown as the service being down.
              r.halted = true;
              if (e !== END && !r.stopped) {
                finishRec(r, "refused", { error: guest ? "service_down" : "internal" });
              }
            },
          );
          const tracked = task.finally(() => {
            r.sending.delete(n);
            live.delete(tracked);
            next();
          });
          live.add(tracked);
        }
        if (!live.size && (r.halted || r.stopped || !queue.length)) resolve(undefined);
      };
      next();
    });
  }

  /** @param {Rec} r */
  async function sendParts(r) {
    set(r, "uploading");
    for (;;) {
      const todo = gaps(r);
      if (!todo.length) return;
      r.halted = false;
      await pump(r, todo);
      if (r.stopped) throw END;
      if (r.halted) await outage(r);
    }
  }

  /** @param {Rec} r @returns {Promise<boolean>} true: complete answered; false: parts are missing, send the gaps */
  async function complete(r) {
    set(r, "checking");
    for (let busy = 0; ; busy++) {
      const body = r.rider ? { n: r.rider.n, etag: r.rider.etag, bytes: r.rider.bytes } : {};
      const res = await ask(r, () => call("POST", `${base(r)}/complete`, body, {}, COMPLETE_MS));
      if (res.status === 400) {
        // The server does not hold the parts the page counted: forget the rider and let the gaps be sent.
        r.rider = null;
        if (!(await sync(r))) await outage(r);
        return false;
      }
      if (res.status === 409 && busy < MAX_BUSY) {
        await pause(r, RETRY_MS[1] ?? 0);
        if (r.stopped) throw END;
        continue;
      }
      if (res.status !== 200) return failed(r, res);
      let b = res.body;
      // The server is still validating: ask until it says ready or refused.
      for (let polls = 0; b?.state === "checking"; polls++) {
        if (polls >= MAX_POLLS) return refuse(r, "service_down");
        await pause(r, POLL_MS);
        if (r.stopped) throw END;
        const again = await ask(r, () => call("GET", base(r)));
        if (again.status !== 200) return failed(r, again);
        if (again.body?.state === "aborted") return gone(r);
        b = again.body;
      }
      if (guest) {
        if (!b || typeof b !== "object") return refuse(r, "service_down");
        finishRec(r, "sent", { view: b });
      } else if (b?.state === "refused") {
        return refuse(r, b.file?.refusal ?? "bad_structure");
      } else {
        finishRec(r, "saved", { fileId: b?.file?.id ?? r.fileId, fileStatus: b?.file?.status ?? b?.state });
      }
      d.vibrate?.(12);
      return true;
    }
  }

  /** @param {Rec} r the create: the same Idempotency-Key on every retry, so a lost answer opens one upload */
  async function open(r) {
    const file = /** @type {NonNullable<Rec["file"]>} */ (r.file);
    set(r, "fingerprinting");
    try {
      r.fp ??= await fingerprint(/** @type {any} */ (file), d.subtle);
    } catch {
      return refuse(r, "bad_request");
    }
    if (r.stopped) throw END;
    set(r, "starting");
    const res = await ask(
      r,
      () =>
        call("POST", "/api/uploads", { name: r.name, bytes: r.size, fingerprint: r.fp }, { "Idempotency-Key": r.key }),
      true,
    );
    const b = res.body;
    const made = (res.status === 200 || res.status === 201) && typeof b?.uploadId === "string" && b.uploadId;
    if (made) r.uploadId = b.uploadId;
    if (r.stopped) {
      // Canceled while the create was on the wire: it may have opened an upload, which is closed again.
      if (made) void call("DELETE", base(r));
      throw END;
    }
    if (!made) return failed(r, res);
    const { partBytes, parts } = b;
    if (
      !Number.isInteger(partBytes) ||
      partBytes < 1 ||
      !Number.isInteger(parts) ||
      parts < 1 ||
      parts > MAX_PARTS ||
      Math.ceil(r.size / partBytes) !== parts
    )
      return refuse(r, "service_down");
    r.plan = planParts(r.size, partBytes);
    r.mode = b.mode === "proxy" ? "proxy" : "direct";
    for (const n of Array.isArray(b.done) ? b.done : []) if (Number.isInteger(n) && n >= 1 && n <= parts) r.done.add(n);
    if (typeof b.fileId === "string") r.fileId = b.fileId;
    keepUrls(r, b.urls, b.ttlMs);
    // A different file chosen over a paused row: that row is closed, which frees its reserved bytes.
    if (r.pausedId && r.pausedId !== r.uploadId) void call("DELETE", pathOf(r.pausedId));
    bump(r);
  }

  /** @param {Rec} r */
  async function run(r) {
    try {
      if (r.size === 0) return refuse(r, "empty");
      await open(r);
      for (let again = 0; again < MAX_ROUNDS; again++) {
        await sendParts(r);
        if (await complete(r)) return;
      }
      return refuse(r, "bad_request");
    } catch (e) {
      if (e !== END && !r.stopped) finishRec(r, "refused", { error: guest ? "service_down" : "internal" });
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (
        let r = records.find((x) => x.state === "queued");
        r && !disposed;
        r = records.find((x) => x.state === "queued")
      )
        await run(r);
    } finally {
      draining = false;
    }
  }

  /** @param {Partial<Rec> & {name: string, size: number, state: State}} fields @returns {Rec} */
  function record(fields) {
    return {
      id: nextId++,
      file: null,
      key: d.uuid(),
      mode: "direct",
      plan: [],
      done: new Set(),
      rider: null,
      urls: new Map(),
      inflight: new Map(),
      sending: new Set(),
      xhrs: new Set(),
      pace: PACE,
      directOk: false,
      netErrs: 0,
      shown: 0,
      stopped: false,
      halted: false,
      outages: 0,
      nudges: new Set(),
      ends: new Set(),
      before: "queued",
      rejected: 0,
      minting: null,
      ...fields,
    };
  }

  const wake = () => {
    for (const r of records) for (const nudge of [...r.nudges]) nudge();
  };
  const halt = () => {
    for (const r of records)
      if (r.state === "uploading") {
        r.halted = true;
        for (const x of r.xhrs) x.abort();
      }
  };
  const visible = () => {
    if (d.doc.visibilityState !== "visible") return;
    wake();
    if (moving) void hold();
  };
  d.win.addEventListener("online", wake);
  d.win.addEventListener("offline", halt);
  d.doc.addEventListener("visibilitychange", visible);

  /** The library's open uploads this page holds no file for, as paused rows. */
  async function loadPaused() {
    const res = await call("GET", "/api/uploads");
    if (disposed || res.status !== 200 || !Array.isArray(res.body?.uploads)) return;
    for (const u of res.body.uploads) {
      if (typeof u?.id !== "string" || typeof u.name !== "string" || !Number.isSafeInteger(u.bytes) || u.bytes < 1)
        continue;
      if (records.some((r) => r.uploadId === u.id)) continue;
      records.push(record({ name: u.name, size: u.bytes, state: "paused", uploadId: u.id }));
    }
    emit();
  }
  if (!guest) void loadPaused();

  /** @param {number} id @returns {Rec | undefined} */
  const find = (id) => records.find((r) => r.id === id);

  return {
    /**
     * Queues files, one upload at a time in the order given; a pick while a batch runs joins it.
     * @param {{name: string, size: number, slice: (s: number, e: number) => Blob}[]} files
     * @returns {number[]} their ids
     */
    add(files) {
      // A batch that has ended is replaced by the new one; paused rows stay.
      if (records.every(ended)) {
        records = records.filter((r) => r.state === "paused");
        eta = etaStart();
      }
      const made = files.map((file) => record({ file, name: file.name, size: file.size, state: "queued" }));
      records.push(...made);
      emit();
      void drain();
      return made.map((r) => r.id);
    },
    /**
     * Ends a file now: its bytes stop and the upload is closed on the server. Too late once it is checking.
     * @param {number} id
     */
    cancel(id) {
      const r = find(id);
      if (!r || r.state === "checking" || (ended(r) && r.state !== "paused")) return;
      const open = r.uploadId;
      finishRec(r, "canceled");
      if (open) void call("DELETE", pathOf(open));
    },
    /**
     * The file chosen again for a paused row: the same fingerprint resumes its upload; another file closes the row and
     * starts fresh.
     * @param {number} id the paused row
     * @param {{name: string, size: number, slice: (s: number, e: number) => Blob}} file
     */
    resume(id, file) {
      const r = find(id);
      if (r?.state !== "paused") return;
      const paused = r.uploadId;
      const same = file.name === r.name && file.size === r.size;
      const fields = { id: r.id, file, name: file.name, size: file.size, state: /** @type {const} */ ("queued") };
      records[records.indexOf(r)] = record(paused && same ? { ...fields, pausedId: paused } : fields);
      // A file that plainly is not the paused one frees the row before it asks for room of its own.
      if (paused && !same) void call("DELETE", pathOf(paused));
      emit();
      void drain();
    },
    /** Stops everything the page holds (the uploads stay open on the server, for the paused row to finish). */
    dispose() {
      disposed = true;
      d.win.removeEventListener("online", wake);
      d.win.removeEventListener("offline", halt);
      d.doc.removeEventListener("visibilitychange", visible);
      d.win.removeEventListener("beforeunload", leaving);
      for (const r of records) {
        r.stopped = true;
        for (const x of r.xhrs) x.abort();
        for (const end of [...r.ends]) end();
      }
      release();
    },
  };
}
