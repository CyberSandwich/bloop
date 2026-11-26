// One per user (idFromName(userId), eu): conversion progress, the hibernating socket to library pages, the user's live
// screens and the export lease (ADR 0015, 0016). It holds only ephemeral rows; the library itself is D1's.
// It never sets a timer and never leaves a promise un-awaited, so it hibernates between frames (LIB-11 hibernate).
// A socket's close needs no handler work: the runtime answers a Close itself.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import {
  allProgress,
  clearProgress,
  dropScreens,
  endScreenRow,
  idemGet,
  idemPut,
  liveScreens,
  type Progress,
  prune,
  putScreen,
  recordProgress,
  rowsLeft,
  type ScreenRow,
} from "./user-library-rules.ts";
import { initUserLibraryStorage } from "./user-library-schema.ts";

const PING = '{"v":1,"t":"ping"}';
const PONG = '{"v":1,"t":"pong"}';
const MAX_SOCKETS = 6;
/** Closed by a newer socket, or at its age limit: the client reconnects and the route checks the cookie again. */
const CLOSE_REPLACED = 4000;
const CLOSE_SESSION_ENDED = 4001;
const SOCKET_MAX_AGE_MS = 12 * 3_600_000;
const SWEEP_MS = 3_600_000;

interface Attachment {
  /** The phone session's public id the socket was opened for. */
  s: string;
  at: number;
}

export class UserLibrary extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const repaired = initUserLibraryStorage(ctx.storage.sql, ctx.storage.kv);
    if (repaired.length > 0) console.warn(JSON.stringify({ evt: "user_library_schema_repaired", tables: repaired }));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The route checked the cookie and Origin and names the session in `X-Session-Public`; nothing else reaches here. */
  override async fetch(request: Request): Promise<Response> {
    const session = request.headers.get("X-Session-Public");
    if (request.headers.get("Upgrade") !== "websocket" || !session) return new Response(null, { status: 426 });
    const open = this.ctx.getWebSockets();
    if (open.length >= MAX_SOCKETS) this.oldest(open)?.close(CLOSE_REPLACED, "replaced");
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [`s:${session}`]);
    server.serializeAttachment({ s: session, at: Date.now() } satisfies Attachment);
    server.send(JSON.stringify({ t: "hello", progress: allProgress(this.ctx.storage.sql) }));
    await this.arm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Frames from a client are ignored: the only message that matters is the ping the runtime answers itself. */
  override async webSocketMessage(): Promise<void> {}

  // ---- Conversion (V) ------------------------------------------------------------------------

  async progress(id: string, version: number, stage: string, done: number, total: number): Promise<void> {
    const p: Progress = { id, version, stage, done, total };
    if (recordProgress(this.ctx.storage.sql, p, Date.now())) this.broadcast({ t: "progress", id, stage, done, total });
    await this.arm();
  }

  /** Page 1 is stored: the tile can show it before the rest. */
  async pageReady(id: string, thumb: string): Promise<void> {
    this.broadcast({ t: "first", id, thumb });
  }

  async derivedReady(id: string, version: number): Promise<void> {
    clearProgress(this.ctx.storage.sql, id, version);
    this.broadcast({ t: "ready", id });
  }

  async derivedFailed(id: string, version: number, code: string): Promise<void> {
    clearProgress(this.ctx.storage.sql, id, version);
    this.broadcast({ t: "failed", id, code });
  }

  /** The list or the quota changed server-side (a purge freed bytes): every open page refetches. */
  async quota(): Promise<void> {
    this.broadcast({ t: "quota" });
  }

  // ---- Live screens (P1) ---------------------------------------------------------------------

  async screenStarted(row: ScreenRow): Promise<void> {
    putScreen(this.ctx.storage.sql, row);
  }

  async screenEnded(sessionId: string): Promise<void> {
    endScreenRow(this.ctx.storage.sql, sessionId, Date.now());
  }

  async listScreens(): Promise<ScreenRow[]> {
    return liveScreens(this.ctx.storage.sql);
  }

  async forgetScreens(sessionIds: string[]): Promise<void> {
    dropScreens(this.ctx.storage.sql, sessionIds);
  }

  // ---- Sessions and erasure ------------------------------------------------------------------

  /** A session ended: its sockets go at once. */
  async closeSession(publicId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`s:${publicId}`)) ws.close(CLOSE_SESSION_ENDED, "session ended");
  }

  /** Account purge: every socket closes, then the storage and its alarm go. */
  async purge(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_SESSION_ENDED, "account erased");
    await this.ctx.storage.deleteAll();
  }

  // ---- Idempotency (the adapter behind idem.ts) ----------------------------------------------

  async idemGet(key: string) {
    return idemGet(this.ctx.storage.sql, key, Date.now());
  }

  async idemPut(key: string, bodyHash: string, answer: string): Promise<void> {
    idemPut(this.ctx.storage.sql, key, bodyHash, answer, Date.now());
    await this.arm();
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || now - att.at >= SOCKET_MAX_AGE_MS) ws.close(CLOSE_REPLACED, "refresh");
    }
    prune(this.ctx.storage.sql, now);
    await this.ctx.storage.deleteAlarm();
    await this.arm();
  }

  /** One alarm at the next need, or none: a socket's age limit, or the next sweep while ephemeral rows are left. */
  private async arm(): Promise<void> {
    const now = Date.now();
    const times = this.ctx.getWebSockets().flatMap((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return att ? [att.at + SOCKET_MAX_AGE_MS] : [];
    });
    if (rowsLeft(this.ctx.storage.sql)) times.push(now + SWEEP_MS);
    const current = await this.ctx.storage.getAlarm();
    if (times.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.max(Math.min(...times), now + 1000);
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  private oldest(sockets: WebSocket[]): WebSocket | undefined {
    const at = (ws: WebSocket) => (ws.deserializeAttachment() as Attachment | null)?.at ?? 0;
    return sockets.reduce<WebSocket | undefined>((a, b) => (a && at(a) <= at(b) ? a : b), undefined);
  }

  private broadcast(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // A socket that cannot take a frame is already closing; the client reconnects and gets the hello.
      }
    }
  }
}
