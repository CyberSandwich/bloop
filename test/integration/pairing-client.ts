// Test clients for the pairing API: an HTTP caller and a WebSocket wrapper that keeps every frame.
import { request as httpRequest } from "node:http";
import { startWrangler, type Wrangler } from "./wrangler.ts";

/** Fake pepper for HMAC of IPs; the Worker refuses to serve pairing routes without one. */
export const PEPPER = "fake-test-pepper-fake-test-pepper-0000";

/** `vars` override wrangler.jsonc vars. TEST_TIMING lowers the config floors and skips the platform bindings. */
export const startPairing = (vars: Record<string, string> = {}): Promise<Wrangler> =>
  startWrangler({ HASH_PEPPER: PEPPER, TEST_TIMING: "1", ...vars });

export interface Reply<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
}

export interface CallOptions {
  /** Bearer credential. */
  auth?: string;
  /** Defaults to the Worker's own origin. */
  origin?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
  /** Sent as is when a string, else JSON-encoded. */
  raw?: string;
}

export class Api {
  constructor(readonly base: string) {}

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = { ...options.headers };
    const origin = options.origin === undefined ? this.base : options.origin;
    if (origin !== null) headers.Origin = origin;
    const contentType = options.contentType === undefined ? "application/json" : options.contentType;
    if (contentType !== null && method !== "GET") headers["Content-Type"] = contentType;
    if (options.auth) headers.Authorization = `Bearer ${options.auth}`;
    const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: payload ?? "{}" }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : {}) as T };
  }

  post = <T = Record<string, unknown>>(path: string, body?: unknown, options?: CallOptions) =>
    this.call<T>("POST", path, body, options);
  get = <T = Record<string, unknown>>(path: string, auth?: string) =>
    this.call<T>("GET", path, undefined, auth ? { auth } : {});
}

export interface Frame {
  v: number;
  t: string;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A WebSocket that records every frame, so a test can wait for one that already arrived. */
export class Socket {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => this.frames.push(JSON.parse(String(e.data)) as Frame));
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
  }

  /** Resolves once open; rejects when the upgrade is refused. */
  static open(base: string, path: string, origin: string | null = base): Promise<Socket> {
    const url = `${base.replace("http", "ws")}${path}`;
    const ws = new WebSocket(url, origin === null ? {} : { headers: { Origin: origin } });
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Socket(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("upgrade refused")), { once: true });
    });
  }

  send(frame: Record<string, unknown> | string): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify({ v: 1, ...frame }));
  }

  /** The first frame, past or future, that matches. */
  async waitFor(match: (f: Frame) => boolean, ms = 6000): Promise<Frame> {
    const deadline = Date.now() + ms;
    let seen = 0;
    while (Date.now() < deadline) {
      for (; seen < this.frames.length; seen++) {
        const frame = this.frames[seen] as Frame;
        if (match(frame)) return frame;
      }
      await sleep(25);
    }
    throw new Error(`no matching frame in ${ms} ms; got ${JSON.stringify(this.frames)}`);
  }

  /** The next frame after everything received so far that matches. */
  async nextFrame(match: (f: Frame) => boolean, ms = 6000): Promise<Frame> {
    this.frames.splice(0, this.frames.length);
    return this.waitFor(match, ms);
  }

  stateWhere(match: (view: Record<string, unknown>) => boolean, ms = 6000): Promise<Frame> {
    return this.waitFor((f) => f.t === "state" && match(f.view as Record<string, unknown>), ms);
  }

  async waitClosed(ms = 8000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.closed) return this.closed;
      await sleep(25);
    }
    throw new Error("socket did not close");
  }

  close(): void {
    this.ws.close();
  }
}

/** An upgrade request as a raw HTTP call, for the cases fetch and WebSocket refuse to send. Returns the status. */
export function rawUpgrade(base: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers: { Connection: "Upgrade", Upgrade: "websocket", ...headers } });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

export interface Screen {
  sid: string;
  ref: string;
  view: Record<string, unknown>;
}

/** A demo screen with its WebSocket authenticated and showing a code. */
export async function openScreen(
  api: Api,
  mode: "demo" | "live" = "demo",
): Promise<{ screen: Screen; socket: Socket; code: string }> {
  const created = await api.post<{ sid: string; view: Record<string, unknown> }>("/api/screens", { mode });
  if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
  const { sid, view } = created.body;
  const ref = sid.split(".")[0] as string;
  const socket = await Socket.open(api.base, `/api/screen/ws?ref=${ref}`);
  socket.send({ t: "hello", sid });
  const state = await socket.stateWhere((v) => v.code !== null);
  const code = ((state.view as { code: { code: string } }).code as { code: string }).code;
  return { screen: { sid, ref, view }, socket, code };
}

export interface Claimed {
  pid: string;
  match: string;
  kind: string;
  needsAuth: boolean;
}

export async function claim(api: Api, code: string, kind: "owner" | "guest" = "owner"): Promise<Reply<Claimed>> {
  return api.post<Claimed>("/api/claim", { code, kind });
}

export async function phoneSocket(api: Api, pid: string): Promise<Socket> {
  const ref = pid.split(".")[0] as string;
  const socket = await Socket.open(api.base, `/api/pair/ws?ref=${ref}`);
  socket.send({ t: "hello", pid });
  await socket.stateWhere(() => true);
  return socket;
}
