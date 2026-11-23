// One Screen object per screen (ADR 0002): the single serialization point for codes, the pairing and
// the timers. It wraps the pure machine; every event is committed synchronously, then its effects run.
// Concurrency rule: async work (hashing, drawing) happens before the check-and-`apply` pair, and
// `apply` commits before its first await, so a credential cannot go stale between check and commit.
import { DurableObject } from "cloudflare:workers";
import type {
  ClaimResponse,
  CodeView,
  ErrorCode,
  LinkSet,
  OpenMode,
  PhoneView,
  ScreenView,
} from "../../shared/protocol.ts";
import type { AuditEvent } from "../audit.ts";
import { type Config, configFor } from "../config.ts";
import type { Env } from "../env.ts";
import { MAX_FRAME_BYTES, phoneFrame, screenFrame } from "../frames.ts";
import { drawCode, drawMatch, newRef, newSecret, parseCredential, safeEqual, sha256Hex } from "../ids.ts";
import { createMachine, type Event, type FileRef, type Machine, nextDeadline, transition } from "../machine.ts";
import { ipHash } from "../routes/common.ts";
import { effectivePolicy } from "../seams/guest-drop/index.ts";
import { purgeGuest } from "../seams/guest-drop/purge.ts";
import { guestDropFor } from "../seams/guest-drop/select.ts";
import { type ClientClass, mintLink, protocolUri } from "../seams/open-path/links.ts";
import type { PairingStore, PhoneInfo, Result, ScreenCreated, UsedLink } from "../seams/pairing.ts";
import { auditFor, metricsFor } from "../stores.ts";
import { directoryStub } from "../stubs.ts";
import { type Meta, phoneView, roomView, screenView } from "../views.ts";
import { bestEffort, type EffectDeps, noopSeams, runEffects, type SessionSeams } from "./effects.ts";
import { LinkLedger } from "./ledger.ts";

const HELLO_MS = 5000;
const MAX_CODE_DRAWS = 3;
const PING = '{"v":1,"t":"ping"}';
const PONG = '{"v":1,"t":"pong"}';
/** WebSocket readyState OPEN. */
const OPEN = 1;

type Role = "screen" | "phone";
interface SocketAttachment {
  role: Role;
  authed: boolean;
  /** Epoch ms by which `hello` must arrive. */
  helloBy: number;
}

type Applied = { ok: true; collided: boolean } | { ok: false; error: ErrorCode };

const fail = (error: ErrorCode): { ok: false; error: ErrorCode } => ({ ok: false, error });

export class Screen extends DurableObject<Env> implements PairingStore {
  private meta: Meta | null;
  private m: Machine | null;
  private readonly links: LinkLedger;
  /** The link set the last mint produced, for the call that asked for it. */
  private lastLinks: LinkSet | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.links = new LinkLedger(ctx.storage.kv);
    this.meta = ctx.storage.kv.get<Meta>("meta") ?? null;
    this.m = ctx.storage.kv.get<Machine>("machine") ?? null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // ---- PairingStore -------------------------------------------------------------------------

  async create(input: {
    screenRef: string;
    mode: Meta["mode"];
    roomId: string | null;
    roomName: string | null;
  }): Promise<Result<ScreenCreated>> {
    const secret = newSecret();
    const screenSecretHash = await sha256Hex(secret);
    if (this.meta) return fail("wrong_state");
    const now = Date.now();
    const cfg = this.config();
    const meta: Meta = { ...input, screenSecretHash, createdAt: now };
    const m = createMachine(input.mode, now, cfg.machine);
    this.meta = meta;
    this.m = m;
    this.ctx.storage.kv.put("meta", meta);
    this.ctx.storage.kv.put("machine", m);
    await this.rearm();
    return {
      ok: true,
      value: { sid: `${input.screenRef}.${secret}`, room: roomView(meta), view: screenView(meta, m, cfg, now) },
    };
  }

  async nextCode(sid: string): Promise<Result<CodeView>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    const issued = await this.issueCode();
    if (!issued.ok) return issued;
    const code = this.currentScreenView().code;
    return code ? { ok: true, value: code } : fail("internal");
  }

  async claim(code: string, phone: PhoneInfo): Promise<Result<ClaimResponse>> {
    if (!this.m || !this.meta) return fail("screen_gone");
    if (phone.kind === "guest" && this.meta.mode === "live") {
      const policy = this.config().guestDrop;
      if (policy === "off") return fail("drop_disabled");
      if (policy === "pass" && !phone.passHash) return fail("pass_required");
    }
    const secret = newSecret();
    const secretHash = await sha256Hex(secret);
    const match = drawMatch();
    // A demo screen never carries an account (architecture 4.5), whatever the route resolved.
    const userId = this.meta.mode === "demo" ? null : phone.userId;
    const applied = await this.apply({
      e: "claim",
      now: Date.now(),
      code,
      sessionId: newRef(),
      secretHash,
      match,
      kind: phone.kind,
      userId,
      passHash: phone.passHash,
    });
    if (!applied.ok) return applied;
    const meta = this.meta as Meta;
    return {
      ok: true,
      value: {
        pid: `${meta.screenRef}.${secret}`,
        room: roomView(meta),
        match,
        mode: meta.mode,
        kind: phone.kind,
        // Only the Graph source has accounts, and a phone already signed in needs nothing more.
        needsAuth: meta.mode === "live" && phone.kind === "owner" && this.config().graph !== null && userId === null,
        dropMaxBytes: this.dropMaxBytes(),
      },
    };
  }

  async listed(pid: string, ids: string[]): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "listed", now: Date.now(), ids }));
  }

  async approve(pid: string, fileId: string, file: FileRef, userId: string | null): Promise<Result<PhoneView>> {
    if (file.ref !== fileId) return fail("bad_request");
    return this.phoneEvent(pid, () => ({
      e: "approve",
      now: Date.now(),
      file,
      maxMinutes: this.sessionMinutes(),
      userId: this.meta?.mode === "demo" ? null : userId,
    }));
  }

  async cancel(pid: string): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "cancel", now: Date.now() }));
  }

  async endFromPhone(pid: string): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "end", now: Date.now(), by: "phone" }));
  }

  async restart(sid: string): Promise<Result<ScreenView>> {
    return this.screenEvent(sid, { e: "restart", now: Date.now() });
  }

  async endFromScreen(sid: string): Promise<Result<ScreenView>> {
    return this.screenEvent(sid, { e: "end", now: Date.now(), by: "screen" });
  }

  /** Polling fallback. With no socket, a poll is also the rotation clock and keeps the screen open. */
  async screenView(sid: string): Promise<Result<ScreenView>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    const code = this.m?.codes.current;
    const due = !code || Date.now() >= code.issuedAt + this.config().machine.codeTtlSeconds * 1000;
    if (this.m?.state === "waiting" && due) await this.issueCode(); // rate_limited: a code is already fresh
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets() });
    return { ok: true, value: this.currentScreenView() };
  }

  async phoneView(pid: string): Promise<Result<PhoneView>> {
    const auth = await this.phoneAuth(pid);
    if (!auth.ok) return auth;
    return this.phoneResult(auth.hash);
  }

  async beginDrop(pid: string, length: number): Promise<Result<{ sessionId: string }>> {
    const auth = await this.phoneAuth(pid);
    if (!auth.ok) return auth;
    const { m, meta } = this;
    if (!m || !meta) return fail("screen_gone");
    if (!this.phoneMatches(auth.hash) || !m.pairing) return fail("pairing_invalid");
    const policy = effectivePolicy(null, meta.mode, this.config().guestDrop);
    if (policy === "off") return fail("drop_disabled");
    if (policy === "pass" && !m.pairing.passHash) return fail("pass_required");
    // One file per session: only the states before a file exists may start an upload.
    if (m.state === "uploading" || m.state === "offered" || m.session) return fail("already_uploaded");
    if (length > this.dropMaxBytes()) return fail("too_large");
    const sessionId = m.pairing.sessionId;
    const applied = await this.apply({
      e: "upload.start",
      now: Date.now(),
      timeoutSeconds: this.config().uploadTimeoutSeconds,
    });
    return applied.ok ? { ok: true, value: { sessionId } } : applied;
  }

  async dropDone(pid: string, file: FileRef): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "upload.done", now: Date.now(), file }));
  }

  async dropFailed(pid: string, error: ErrorCode): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "upload.failed", now: Date.now(), error }));
  }

  async mintFallback(sid: string, mode: OpenMode): Promise<Result<LinkSet>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    this.lastLinks = null;
    const applied = await this.apply({ e: "fallback", now: Date.now(), mode, maxMints: this.config().links.maxMints });
    if (!applied.ok) return applied;
    return this.lastLinks ? { ok: true, value: this.lastLinks } : fail("internal");
  }

  async useLink(
    tokenHash: string,
    ipHashed: string,
    via: { method: string; client: ClientClass },
  ): Promise<Result<UsedLink>> {
    const { m, meta } = this;
    const session = m?.session;
    if (!m || !meta || !m.pairing) return fail("link_unknown");
    const now = Date.now();
    const { links: limits } = this.config();
    const screenIp = this.ctx.storage.kv.get<string>("screenIp");
    const ipMatch = screenIp === undefined ? null : screenIp === ipHashed;
    const binding = limits.binding === "enforce" && ipMatch === false ? "link_binding_failed" : null;
    const used = this.links.use(tokenHash, now, limits, binding);
    const sessionId = m.pairing.sessionId;
    if (!used.ok) {
      if (used.error !== "link_unknown")
        await this.auditLink(sessionId, now, "link.refused", { cause: used.error, ...via });
      return fail(used.error);
    }
    if (!session) return fail("link_revoked"); // ended: the file reference is gone with the session
    await this.auditLink(sessionId, now, "link.fetched", {
      purpose: used.record.purpose,
      count: used.record.fetches,
      ...(limits.binding !== "off" && ipMatch !== null ? { ipMatch } : {}),
      ...via,
    });
    await this.apply({ e: "fetched", now });
    return {
      ok: true,
      value: { file: session.file, purpose: used.record.purpose, mode: meta.mode, userId: m.pairing.userId },
    };
  }

  // ---- WebSockets ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (!this.m) return new Response(null, { status: 410 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response(null, { status: 426 });
    const role: Role = new URL(request.url).pathname.endsWith("/screen/ws") ? "screen" : "phone";
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    if (role === "screen") this.ctx.storage.kv.put("screenIp", await ipHash(request, this.config()));
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, authed: false, helloBy: Date.now() + HELLO_MS } satisfies SocketAttachment);
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets() });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || !this.m) return ws.close(1011, "gone");
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return ws.close(1008, "frame");
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return ws.close(1008, "frame");
    }

    if (att.role === "phone") {
      const parsed = phoneFrame.safeParse(raw);
      if (!parsed.success) return ws.close(1008, "frame");
      if (parsed.data.t === "ping") return ws.send(PONG);
      if (att.authed) return ws.close(1008, "hello");
      return this.hello(ws, att, parsed.data.pid);
    }

    const parsed = screenFrame.safeParse(raw);
    if (!parsed.success) return ws.close(1008, "frame");
    const msg = parsed.data;
    if (msg.t === "ping") return ws.send(PONG);
    if (msg.t === "hello") return att.authed ? ws.close(1008, "hello") : this.hello(ws, att, msg.sid);
    if (!att.authed) return ws.close(1008, "hello");

    const now = Date.now();
    const result =
      msg.t === "code.next"
        ? await this.issueCode()
        : msg.t === "open.click"
          ? await this.apply({ e: "open.click", now, maxMinutes: this.sessionMinutes() })
          : await this.apply({ e: "launched", now, mode: msg.mode });
    if (!result.ok) ws.send(JSON.stringify({ v: 1, t: "error", code: result.error, now: Date.now() }));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets(ws) });
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets(ws) });
  }

  override async alarm(): Promise<void> {
    if (!this.m) return;
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att && !att.authed && att.helloBy <= now) {
        ws.send(JSON.stringify({ v: 1, t: "error", code: "unauthorized", now }));
        ws.close(1008, "hello timeout");
      }
    }
    await this.apply({ e: "timer", now });
  }

  // ---- internals ----------------------------------------------------------------------------

  private config(): Config {
    const result = configFor(this.env);
    if (!result.ok) {
      console.error(`config invalid: ${result.problems.join("; ")}`);
      throw new Error("config invalid");
    }
    return result.config;
  }

  private sessionMinutes(): number {
    const cfg = this.config();
    return this.meta?.mode === "demo" ? cfg.demoSessionMinutes : cfg.sessionMaxMinutes;
  }

  private dropMaxBytes(): number {
    const cfg = this.config();
    return this.meta?.mode === "demo" ? cfg.demoGuestMaxBytes : cfg.guestMaxBytes;
  }

  private openSockets(excluding?: WebSocket): number {
    return this.ctx.getWebSockets().filter((w) => w !== excluding && w.readyState === OPEN).length;
  }

  private currentScreenView(): ScreenView {
    return screenView(this.meta as Meta, this.m as Machine, this.config(), Date.now());
  }

  /** The screen's secret half, hashed and compared in constant time. */
  private async screenAuth(sid: string): Promise<{ ok: true } | { ok: false; error: ErrorCode }> {
    if (!this.m || !this.meta) return fail("screen_gone");
    const cred = parseCredential(sid);
    if (!cred || cred.ref !== this.meta.screenRef) return fail("unauthorized");
    const hash = await sha256Hex(cred.secret);
    // Re-read after the await: the object may have closed meanwhile.
    return this.meta && safeEqual(hash, this.meta.screenSecretHash) ? { ok: true } : fail("unauthorized");
  }

  /** Hashes the pairing secret. Matching against the current pairing happens later, at apply time. */
  private async phoneAuth(pid: string): Promise<{ ok: true; hash: string } | { ok: false; error: ErrorCode }> {
    if (!this.m || !this.meta) return fail("screen_gone");
    const cred = parseCredential(pid);
    if (!cred || cred.ref !== this.meta.screenRef) return fail("pairing_invalid");
    return { ok: true, hash: await sha256Hex(cred.secret) };
  }

  private phoneMatches(hash: string): boolean {
    const stored = this.m?.pairing?.secretHash;
    return stored !== undefined && safeEqual(hash, stored);
  }

  private phoneResult(hash: string): Result<PhoneView> {
    if (!this.m || !this.meta) return fail("screen_gone");
    const view = this.phoneMatches(hash) ? phoneView(this.meta, this.m, Date.now(), this.dropMaxBytes()) : null;
    return view ? { ok: true, value: view } : fail("pairing_invalid");
  }

  private async phoneEvent(pid: string, event: () => Event): Promise<Result<PhoneView>> {
    const auth = await this.phoneAuth(pid);
    if (!auth.ok) return auth;
    const { m: before, meta } = this;
    if (!before || !meta) return fail("screen_gone");
    if (!this.phoneMatches(auth.hash)) return fail("pairing_invalid");
    const applied = await this.apply(event());
    if (!applied.ok) return applied;
    if (this.phoneMatches(auth.hash)) return this.phoneResult(auth.hash);
    // A cancel dropped the pairing. The phone that asked sees its session as ended by cancel.
    const view = phoneView(
      meta,
      { ...before, state: "ended", session: null, endReason: "canceled" },
      Date.now(),
      this.dropMaxBytes(),
    );
    return view ? { ok: true, value: view } : fail("pairing_invalid");
  }

  private async screenEvent(sid: string, ev: Event): Promise<Result<ScreenView>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    const applied = await this.apply(ev);
    if (!applied.ok) return applied;
    return { ok: true, value: this.currentScreenView() };
  }

  /** Commits one event, runs its effects, re-arms the alarm. See the concurrency rule at the top. */
  private async apply(ev: Event): Promise<Applied> {
    const { m, meta } = this;
    if (!m || !meta) return fail("screen_gone");
    const step = transition(m, ev, this.config().machine);
    if (!step.ok) return step;
    if (step.next !== m) {
      this.m = step.next;
      this.ctx.storage.kv.put("machine", step.next);
    }
    const { collided } = await runEffects(step.effects, { meta, prev: m, next: step.next, now: ev.now }, this.deps());
    const after = this.m;
    if (!after) return { ok: true, collided }; // closed: storage is gone
    if (!after.pairing) this.closePhoneSockets();
    await this.rearm();
    // A drop back to waiting leaves no code; the screen gets a fresh one at once.
    if (!collided && after.state === "waiting" && !after.codes.current && m.state !== "waiting") {
      await this.issueCode();
    }
    return { ok: true, collided };
  }

  /** Issues a code; on a Directory collision (about 1 in 1e6) draws again. */
  private async issueCode(): Promise<Applied> {
    const length = this.config().codeLength;
    for (let draw = 0; draw < MAX_CODE_DRAWS; draw++) {
      const applied = await this.apply({ e: "code.next", now: Date.now(), value: drawCode(length) });
      if (!applied.ok || !applied.collided) return applied;
    }
    return fail("internal");
  }

  private async hello(ws: WebSocket, att: SocketAttachment, credential: string): Promise<void> {
    let auth: { ok: true } | { ok: false; error: ErrorCode };
    if (att.role === "screen") {
      auth = await this.screenAuth(credential);
    } else {
      const phone = await this.phoneAuth(credential);
      auth = phone.ok && !this.phoneMatches(phone.hash) ? fail("pairing_invalid") : phone;
    }
    if (!auth.ok) {
      ws.send(JSON.stringify({ v: 1, t: "error", code: auth.error, now: Date.now() }));
      return ws.close(1008, "auth");
    }
    ws.serializeAttachment({ ...att, authed: true } satisfies SocketAttachment);
    this.sendState(ws, att.role);
    if (att.role === "screen" && this.m?.state === "waiting" && !this.m.codes.current) await this.issueCode();
    await this.rearm();
  }

  private sendState(ws: WebSocket, role: Role): void {
    const { meta, m } = this;
    if (!meta || !m) return;
    const now = Date.now();
    const view =
      role === "screen" ? screenView(meta, m, this.config(), now) : phoneView(meta, m, now, this.dropMaxBytes());
    const frame = view
      ? { v: 1, t: "state", view }
      : { v: 1, t: "error", code: "pairing_invalid" satisfies ErrorCode, now };
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // the socket closed under us; its close handler updates the count
    }
  }

  private push(to: Role | "both"): void {
    for (const role of ["screen", "phone"] as const) {
      if (to !== "both" && to !== role) continue;
      for (const ws of this.ctx.getWebSockets(role)) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (att?.authed) this.sendState(ws, role);
      }
    }
  }

  /** A phone socket outlives its pairing only until the next event: close it. */
  private closePhoneSockets(): void {
    for (const ws of this.ctx.getWebSockets("phone")) {
      try {
        ws.close(1000, "done");
      } catch {
        // already closed
      }
    }
  }

  private async auditLink(
    sessionId: string,
    at: number,
    type: "link.minted" | "link.fetched" | "link.refused",
    detail: AuditEvent["detail"],
  ): Promise<void> {
    await bestEffort(auditFor(this.env).record({ sessionId, at, actor: "system", type, detail }));
  }

  /** The link seams (docs/interfaces.md section 4): mint pushes the link to the screen, revoke kills them all. */
  private linkSeams(): Pick<SessionSeams, "mint" | "revokeLinks"> {
    return {
      mint: async (purpose) => {
        const { m, meta } = this;
        const file = m?.session?.file;
        if (!m?.pairing || !meta || !file) return;
        const now = Date.now();
        const link = await mintLink(meta.screenRef, file, purpose, this.config().origin);
        this.links.add({
          tokenHash: link.tokenHash,
          purpose: link.purpose,
          mintedAt: now,
          firstFetchAt: null,
          fetches: 0,
          revoked: false,
        });
        const links: LinkSet = {
          protocol: link.purpose === "protocol" ? protocolUri(link.url) : null,
          download: link.purpose === "download" ? link.url : null,
          pdf: link.purpose === "pdf" ? link.url : null,
        };
        this.lastLinks = links;
        this.sendOpen(links);
        await this.auditLink(m.pairing.sessionId, now, "link.minted", { purpose: link.purpose });
      },
      revokeLinks: async () => void this.links.revokeAll(),
    };
  }

  /** Deletes the guest object at every end of the session (seams/guest-drop/purge.ts). */
  private guestSeams(): Pick<SessionSeams, "purge"> {
    return {
      purge: (input) =>
        purgeGuest({ drop: guestDropFor(this.env, this.config()), audit: auditFor(this.env), now: Date.now }, input),
    };
  }

  /** The `open` frame: sent once per mint to the screen sockets, never repeated in `state`. */
  private sendOpen(links: LinkSet): void {
    const frame = JSON.stringify({ v: 1, t: "open", links, now: Date.now() });
    for (const ws of this.ctx.getWebSockets("screen")) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att?.authed) continue;
      try {
        ws.send(frame);
      } catch {
        // the socket closed under us; the screen asks again on its next view
      }
    }
  }

  private deps(): EffectDeps {
    return {
      directory: directoryStub(this.env),
      audit: auditFor(this.env),
      metrics: metricsFor(this.env),
      seams: { ...noopSeams, ...this.linkSeams(), ...this.guestSeams() },
      push: (to) => this.push(to),
      deleteAll: async () => {
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1000, "closed");
          } catch {
            // already closed
          }
        }
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.m = null;
        this.meta = null;
      },
    };
  }

  /** One alarm, at the earliest of the machine's deadline and any pending hello timeout. */
  private async rearm(): Promise<void> {
    if (!this.m) return;
    const times = [nextDeadline(this.m, this.config().machine)];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att && !att.authed && ws.readyState === OPEN) times.push(att.helloBy);
    }
    const due = times.filter((t): t is number => t !== null);
    if (due.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...due));
  }
}
