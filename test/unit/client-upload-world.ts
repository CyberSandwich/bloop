// A fake world for the upload engine: a clock and timers the test moves, a server that answers the wire contract, XHRs
// the test answers part by part, and the page's events. Nothing here is the engine's own logic.
import { createUploader } from "../../public/js/core/upload.js";

// The engine fetches the name rule on first use; loading it here keeps every flush as short as before.
await import("../../public/js/shared/file-name.js").catch(() => undefined);

export const MARK = { "X-Bloop": "1" };
export const NETWORK = Symbol("network");
// The real timer, kept for flush: a test that fakes the global one still settles.
const tick = globalThis.setTimeout;

export interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

/** One part on the wire: the test shows progress and answers it. */
export class Put {
  aborted = false;
  finished = false;
  headers: Record<string, string> = {};
  method = "";
  url = "";
  size = 0;
  body: unknown;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  private answer: { etag?: string; ours: boolean; retryAfter?: string } = { ours: true };
  constructor(private world: World) {}
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader(name: string) {
    const lower = name.toLowerCase();
    if (lower === "etag") return this.answer.etag ?? null;
    if (lower === "x-bloop") return this.answer.ours ? "1" : null;
    if (lower === "retry-after") return this.answer.retryAfter ?? null;
    return null;
  }
  send(blob: Blob) {
    this.body = blob;
    this.size = blob.size;
    this.world.puts.push(this);
    this.world.onPut(this);
  }
  abort() {
    this.aborted = true;
    this.finished = true;
    this.onabort?.();
  }
  progress(loaded: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total: this.size });
  }
  /** The part number a URL names: the last digits of a proxy path or of a direct URL's path. */
  get n() {
    return Number(/(\d+)(?:\?.*)?$/.exec(this.url)?.[1]);
  }
  reply(status: number, more: { etag?: string; text?: string; ours?: boolean; retryAfter?: string } = {}) {
    this.finished = true;
    this.status = status;
    this.responseText = more.text ?? "";
    this.answer = {
      ours: more.ours ?? true,
      ...(more.etag ? { etag: more.etag } : {}),
      ...(more.retryAfter ? { retryAfter: more.retryAfter } : {}),
    };
    this.onload?.();
  }
  ok() {
    // A part sent through bloop is recorded by the server as it is stored; a direct one is confirmed by the page.
    if (this.url.startsWith("/api/")) {
      this.world.state.done.add(this.n);
      this.reply(200, { text: JSON.stringify({ n: this.n, etag: `"e${this.n}"` }) });
    } else this.reply(200, { etag: `"e${this.n}"` });
  }
  fail() {
    this.finished = true;
    this.onerror?.();
  }
}

class Events {
  private listeners = new Map<string, Set<(e: any) => void>>();
  addEventListener(type: string, fn: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string, event: any = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

export interface Options {
  mode?: "direct" | "proxy";
  partBytes?: number;
  /** Parts the create answer carries URLs for. */
  firstUrls?: number;
  /** How long a minted URL lives. */
  ttlMs?: number;
  done?: number[];
  wakeLock?: boolean;
  /** A guest's pairing credential: the engine runs on the guest routes with it as the Bearer. */
  pid?: string;
}

export type World = ReturnType<typeof makeWorld>;

export function makeWorld(options: Options = {}) {
  const partBytes = options.partBytes ?? 20;
  const root = options.pid ? "/api/guest/uploads" : "/api/uploads";
  const state = {
    now: 0,
    id: 0,
    mints: 0,
    keys: 0,
    bytes: 0,
    fingerprint: undefined as string | undefined,
    /** Completes answered `checking` before one settles. */
    checking: 0,
    mode: options.mode ?? "direct",
    done: new Set(options.done ?? []),
  };
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const calls: Call[] = [];
  const puts: Put[] = [];
  const snaps: any[] = [];
  const win = Object.assign(new Events(), { location: { origin: "https://bloop.test" } });
  const doc = Object.assign(new Events(), { visibilityState: "visible" });
  const locks: { released: boolean }[] = [];
  const vibrations: number[] = [];
  /** Answers first: return a Response, NETWORK for a dropped request, or undefined to fall through. */
  const intercept: ((c: Call) => Response | Promise<Response | undefined> | typeof NETWORK | undefined)[] = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { ...MARK, ...headers } });
  const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
    json(status, { type: "about:blank", status, code }, headers);

  const urlsFor = (parts: number[], mode: string = state.mode) =>
    parts.map((n) => ({
      n,
      url:
        mode === "proxy"
          ? `${root}/up1/parts/${n}`
          : `https://acct.eu.r2.cloudflarestorage.com/up1/${n}?sig=${++state.mints}`,
    }));

  const server = (call: Call): Response => {
    const { method, path, body } = call;
    if (method === "POST" && path === root) {
      state.bytes = body.bytes;
      // One upload row: another file starts it afresh.
      if (state.fingerprint !== undefined && state.fingerprint !== body.fingerprint) state.done.clear();
      state.fingerprint = body.fingerprint as string;
      const parts = Math.ceil(body.bytes / partBytes);
      const first = [...Array(parts).keys()].map((i) => i + 1).filter((n) => !state.done.has(n));
      return json(state.done.size ? 200 : 201, {
        uploadId: "up1",
        fileId: "f1",
        partBytes,
        parts,
        done: [...state.done],
        mode: state.mode,
        expiresAt: 0,
        ttlMs: options.ttlMs ?? 300000,
        urls: urlsFor(first.slice(0, options.firstUrls ?? 8)),
      });
    }
    if (method === "GET" && path === root) return json(200, { uploads: [] });
    // The routes' bodies are strict (zod): a key the server does not know is a 400, as here.
    if (method === "POST" && path === `${root}/up1/urls`)
      return Object.keys(body ?? {}).join() === "parts" && Array.isArray(body.parts)
        ? json(200, { urls: urlsFor(body.parts), ttlMs: options.ttlMs ?? 300000 })
        : problem(400, "invalid_body");
    const done = new RegExp(`^${root}/up1/parts/(\\d+)/done$`).exec(path);
    if (method === "POST" && done) {
      state.done.add(Number(done[1]));
      return json(200, { n: Number(done[1]), confirmed: state.done.size, total: 0 });
    }
    if (method === "POST" && path === `${root}/up1/complete`) {
      const keys = Object.keys(body ?? {})
        .sort()
        .join();
      const total = Math.ceil(state.bytes / partBytes);
      // {} or {n, etag, bytes}, and the one part that rides is the last, with every other part done.
      const rider = keys === "bytes,etag,n" ? Number(body.n) : 0;
      const sound = (keys === "" || rider === total) && state.done.size + (rider ? 1 : 0) === total;
      if (!sound) return problem(400, "invalid_body");
      if (state.checking > 0) {
        state.checking--;
        return json(200, { state: "checking", file: { id: "f1", status: "checking" } });
      }
      return json(200, { state: "ready", file: { id: "f1", status: "ready" } });
    }
    if (method === "GET" && path === `${root}/up1`)
      return json(200, { id: "up1", state: "open", done: [...state.done] });
    if (method === "DELETE" && path === `${root}/up1`) return json(204, null);
    return problem(404, "not_found");
  };

  const fetch = async (path: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: { ...(init.headers as Record<string, string>) },
    };
    calls.push(call);
    for (const handler of intercept) {
      const out = await handler(call);
      if (out === NETWORK) throw new TypeError("Failed to fetch");
      if (out) return out;
    }
    return server(call);
  };

  const world = {
    state,
    calls,
    puts,
    snaps,
    win,
    doc,
    locks,
    vibrations,
    intercept,
    /** Holds every wake-lock request until it settles. */
    lockGate: undefined as Promise<void> | undefined,
    json,
    problem,
    /** What the page does with a part the moment it is sent. The default answers it. */
    onPut: (put: Put) => put.ok(),
    get now() {
      return state.now;
    },
    deps: {
      fetch,
      xhr: () => new Put(world as unknown as World),
      now: () => state.now,
      setTimeout: (fn: () => void, ms: number) => {
        const t = { at: state.now + ms, fn, id: ++state.id };
        timers.push(t);
        return t;
      },
      clearTimeout: (t: unknown) => {
        const i = timers.indexOf(t as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
      uuid: () => `key-${++state.keys}`,
      // Settles in the same flush however loaded the machine is; real SHA-256 is covered in client-upload.test.ts.
      subtle: {
        digest: async (_name: string, data: ArrayBuffer) => {
          const bytes = new Uint8Array(data);
          const out = new Uint8Array(new ArrayBuffer(32));
          bytes.forEach((b, i) => {
            out[i % 32] = ((out[i % 32] ?? 0) * 31 + b) & 255;
          });
          return out.buffer;
        },
      },
      win,
      doc,
      wakeLock: options.wakeLock
        ? {
            request: async () => {
              await world.lockGate;
              const lock = { released: false };
              locks.push(lock);
              return {
                release: async () => {
                  lock.released = true;
                },
                addEventListener: () => {},
              };
            },
          }
        : undefined,
      vibrate: (ms: number) => vibrations.push(ms),
    },
    /** Lets every promise settle. */
    async flush() {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => tick(resolve, 0));
    },
    /** Moves the clock, running each timer in its turn. */
    async advance(ms: number) {
      const target = state.now + ms;
      await world.flush();
      for (;;) {
        const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        state.now = Math.max(state.now, next.at);
        next.fn();
        await world.flush();
      }
      state.now = target;
      await world.flush();
    },
    pending: () => timers.length,
    uploader: undefined as undefined | ReturnType<typeof createUploader>,
    start() {
      world.uploader = createUploader({
        onChange: (batch) => snaps.push(structuredClone(batch)),
        ...(options.pid ? { pid: options.pid } : {}),
        deps: world.deps as never,
      });
      return world.uploader;
    },
    get last() {
      return snaps[snaps.length - 1];
    },
    file(size: number, name = "Lecture 5.pptx") {
      return new File([new Uint8Array(size).fill(7)], name);
    },
    calledPaths: (method?: string) =>
      calls.filter((c) => !method || c.method === method).map((c) => `${c.method} ${c.path}`),
    live: () => puts.filter((p) => !p.finished),
  };
  return world;
}
