// One Screen object per screen (ADR 0002): the single serialization point for codes, the pairing and
// the timers. It wraps the pure machine; every event is committed synchronously, then its effects run.
// Concurrency rule: async work (hashing, drawing) happens before the check-and-`apply` pair, and
// `apply` commits before its first await, so a credential cannot go stale between check and commit.
import { DurableObject } from "cloudflare:workers";
import { ERRORS } from "../../../public/js/shared/errors.js";
import type {
  ClaimResponse,
  CodeView,
  ErrorCode,
  LinkResponse,
  LinkSet,
  OpenMode,
  PhoneView,
  ScreenView,
  ShownCommand,
} from "../../shared/protocol.ts";
import type { AuditEvent } from "../audit.ts";
import { type Config, configFor } from "../config.ts";
import type { Env } from "../env.ts";
import { MAX_FRAME_BYTES, phoneFrame, screenFrame } from "../frames.ts";
import { drawCode, drawMatch, newRef, newSecret, parseCredential, safeEqual, sha256Hex } from "../ids.ts";
import { fileAt, type ItemDraft } from "../items.ts";
import {
  createMachine,
  type Event,
  type FileRef,
  type Machine,
  type MachineError,
  nextDeadline,
  transition,
} from "../machine.ts";
import { ipHash, netHash } from "../routes/common.ts";
import { effectivePolicy } from "../seams/guest-drop/index.ts";
import { purgeGuest } from "../seams/guest-drop/purge.ts";
import { guestDropFor } from "../seams/guest-drop/select.ts";
import {
  type ClientClass,
  type LinkRecord,
  MAX_AUDITED_IPS,
  mintLink,
  protocolUri,
  refusalSession,
} from "../seams/open-path/links.ts";
import { ownerEnd } from "../seams/open-path/lookups.ts";
import type { PairingStore, PhoneInfo, Result, ScreenCreated, UsedLink } from "../seams/pairing.ts";
import { auditFor, metricsFor } from "../stores.ts";
import { directoryStub } from "../stubs.ts";
import { type Meta, phoneView, roomView, screenView } from "../views.ts";
import { bestEffort, closeObject, type EffectDeps, noopSeams, runEffects, type SessionSeams } from "./effects.ts";
import { LinkLedger, type Use } from "./ledger.ts";
import { migrate, SCHEMA_KEY, SCHEMA_VERSION } from "./schema.ts";
import { admit, countAuthed, holdBinding, isLive, screensOf } from "./sockets.ts";

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
  /** The upgrade's address hash: a screen's becomes the link binding only once `hello` verifies the sid (OPEN-02). */
  ip: string;
  /** The hash of its network (an IPv6 /64), which caps the sockets waiting for their `hello`. */
  net: string;
  /** When `hello` verified: a socket is live from then, or from its last answered ping. */
  helloAt?: number;
}

/** `next`: the machine the event committed, which outlives `this.m` when the event closed the object. */
type Applied =
  | { ok: true; collided: boolean; next: Machine; minted: LinkResponse | null }
  | { ok: false; error: MachineError };

type LinkVia = { method: string; client: ClientClass };

const fail = (error: ErrorCode): { ok: false; error: ErrorCode } => ({ ok: false, error });
const isErrorCode = (error: string): error is ErrorCode => Object.hasOwn(ERRORS, error);

export class Screen extends DurableObject<Env> implements PairingStore {
  private meta: Meta | null;
  private m: Machine | null;
  private readonly links: LinkLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.links = new LinkLedger(ctx.storage.kv);
    migrate(ctx.storage.kv);
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
    this.ctx.storage.kv.put(SCHEMA_KEY, SCHEMA_VERSION);
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

  async control(pid: string, { seq, ...shown }: ShownCommand): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "control", now: Date.now(), from: "phone", seq, shown }));
  }

  async reportShown(sid: string, { seq, ...shown }: ShownCommand): Promise<Result<ScreenView>> {
    return this.screenEvent(sid, { e: "control", now: Date.now(), from: "screen", seq, shown });
  }

  /** A change that arrives after the end ends the session (the machine's `length`), and says so: `session_ended`. */
  async setLength(pid: string, seconds: number): Promise<Result<PhoneView>> {
    const res = await this.phoneEvent(pid, () => ({
      e: "length",
      now: Date.now(),
      seconds,
      maxMinutes: this.maxMinutes(),
    }));
    return res.ok && res.value.state === "ended" ? fail("session_ended") : res;
  }

  async approve(pid: string, items: ItemDraft[]): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "approve", now: Date.now(), items, minutes: this.sessionMinutes() }));
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

  /**
   * Ends the session `userId` owns here, as the phone's End would, by "system". Called object to object only (the
   * library's endScreens): no route or frame reaches it, since the caller holds no credential of this screen.
   * Idempotent: no pairing, another owner or an ended session changes nothing.
   */
  async endFromOwner(userId: string): Promise<Result<null>> {
    const ev = ownerEnd(this.m, userId, Date.now());
    const applied = ev ? await this.apply(ev) : null;
    return !applied || applied.ok ? { ok: true, value: null } : applied;
  }

  /** Polling fallback. With no socket, a poll is also the rotation clock and keeps the screen open. */
  async screenView(sid: string, ip: string): Promise<Result<ScreenView>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    this.bindLinksUnlessLive(ip);
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

  async dropDone(pid: string, file: FileRef): Promise<Result<PhoneView, ErrorCode>> {
    const done = await this.phoneEvent(pid, () => ({ e: "upload.done", now: Date.now(), file }));
    if (done.ok) return done;
    // upload.start is gated by the pick, so no pick code can follow it here.
    return fail(isErrorCode(done.error) ? done.error : "internal");
  }

  async dropFailed(pid: string, error: ErrorCode): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "upload.failed", now: Date.now(), error }));
  }

  async mintFallback(sid: string, mode: OpenMode, item: number | null): Promise<Result<LinkResponse>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    const maxMints = this.config().links.maxMints;
    const applied = await this.apply({ e: "fallback", now: Date.now(), mode, item, maxMints });
    if (!applied.ok) return applied;
    return applied.minted ? { ok: true, value: applied.minted } : fail("internal");
  }

  async checkLink(tokenHash: string, ipHashed: string, via: LinkVia): Promise<Result<{ purpose: OpenMode }>> {
    const { m } = this;
    if (!m?.pairing) return fail("link_unknown");
    const now = Date.now();
    const { links: limits } = this.config();
    const checked = this.links.check(tokenHash, now, limits, this.linkIp(ipHashed).binding);
    if (!checked.ok) return this.linkRefused(checked, now, via);
    return { ok: true, value: { purpose: checked.record.purpose } };
  }

  async useLink(tokenHash: string, ipHashed: string, via: LinkVia): Promise<Result<UsedLink>> {
    const { m, meta } = this;
    const session = m?.session;
    if (!m || !meta || !m.pairing) return fail("link_unknown");
    const now = Date.now();
    const { links: limits } = this.config();
    const { ipMatch, binding } = this.linkIp(ipHashed);
    const used = this.links.use(tokenHash, now, limits, binding);
    if (!used.ok) return this.linkRefused(used, now, via);
    const file = session && fileAt(session.items, used.record.item);
    if (!file) return fail("link_revoked"); // ended: the file reference is gone with the session
    const shown = limits.binding !== "off" && ipMatch !== null;
    if (this.auditsFetch(used.record, shown && ipMatch === false ? ipHashed : null)) {
      await this.auditLink(m.pairing.sessionId, now, "link.fetched", {
        purpose: used.record.purpose,
        count: used.record.fetches,
        ...(shown ? { ipMatch } : {}),
        ...via,
      });
    }
    await this.apply({ e: "fetched", now });
    return {
      ok: true,
      value: { file, purpose: used.record.purpose, mode: meta.mode, userId: m.pairing.userId },
    };
  }

  // ---- WebSockets ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response(null, { status: 426 });
    const role: Role = new URL(request.url).pathname.endsWith("/screen/ws") ? "screen" : "phone";
    // Hash first: from the object check to the accept nothing awaits, so a burst cannot all see one count. Closing
    // clears this.m before its first await (deleteAll), so an upgrade checked after that is refused, and one accepted
    // before it is closed by its loop.
    const cfg = this.config();
    const [ip, net] = [await ipHash(request, cfg), await netHash(request, cfg)];
    if (!this.m) return new Response(null, { status: 410 });
    const now = Date.now();
    // The waiting socket given up for this one (sockets.ts admit): its hello window ends now, and the alarm below
    // closes it as it does any socket that sent no hello.
    const evict = admit(this.openEntries(), role, net, now);
    if (evict) evict.ws.serializeAttachment({ ...evict.att, helloBy: now });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, authed: false, helloBy: now + HELLO_MS, ip, net } satisfies SocketAttachment);
    // Only the hello timeout: a bare upgrade is no socket event and never moves the close deadline.
    await this.rearm();
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
          ? await this.apply({ e: "open.click", now, minutes: this.sessionMinutes() })
          : await this.apply({ e: "launched", now, mode: msg.mode });
    if (!result.ok) ws.send(JSON.stringify({ v: 1, t: "error", code: result.error, now: Date.now() }));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  /** A socket that never authed was never counted, so its end changes nothing. */
  private async socketGone(ws: WebSocket): Promise<void> {
    if (!(ws.deserializeAttachment() as SocketAttachment | null)?.authed) return;
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

  /** The mode's cap: no session ends later than its approval plus this. */
  private maxMinutes(): number {
    const cfg = this.config();
    return this.meta?.mode === "demo" ? cfg.demoMaxMinutes : cfg.sessionMaxMinutes;
  }

  /** The length a session starts with: the default, within the mode's cap. */
  private sessionMinutes(): number {
    return Math.min(this.config().sessionDefaultMinutes, this.maxMinutes());
  }

  private dropMaxBytes(): number {
    const cfg = this.config();
    return this.meta?.mode === "demo" ? cfg.demoGuestMaxBytes : cfg.guestMaxBytes;
  }

  private phoneViewOf(m: Machine): PhoneView | null {
    const limits = { dropMaxBytes: this.dropMaxBytes(), maxMinutes: this.maxMinutes() };
    return phoneView(this.meta as Meta, m, Date.now(), limits);
  }

  /** The link binding (OPEN-02): the address of a screen that proved its sid, by socket `hello` or by poll. */
  private bindLinksTo(ip: string): void {
    if (this.ctx.storage.kv.get("screenIp") !== ip) this.ctx.storage.kv.put("screenIp", ip);
  }

  private openEntries(excluding?: WebSocket): { ws: WebSocket; att: SocketAttachment | null }[] {
    return this.ctx
      .getWebSockets()
      .filter((w) => w !== excluding && w.readyState === OPEN)
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as SocketAttachment | null }));
  }

  private openAttachments(excluding?: WebSocket): (SocketAttachment | null)[] {
    return this.openEntries(excluding).map((e) => e.att);
  }

  /**
   * Proof of the sid, by `hello` or by poll, moves the link binding (OPEN-02) unless another authed screen socket is
   * live, so a leaked sid cannot take the binding from a lectern that is still talking. Otherwise the newest proof wins.
   */
  private bindLinksUnlessLive(ip: string, except?: WebSocket): void {
    const now = Date.now();
    const silence = this.config().socketSilenceMs;
    if (!this.authedScreens(except).some((s) => isLive(s.heardAt, now, silence))) this.bindLinksTo(ip);
  }

  /** The open screen sockets whose `hello` verified, with when each was last heard (its hello or an answered ping). */
  private authedScreens(except?: WebSocket): { ip: string; helloAt: number; heardAt: number }[] {
    const entries = this.openEntries(except).map(({ ws, att }) => ({
      att,
      pong: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
    }));
    return screensOf(entries, Date.now());
  }

  private openSockets(excluding?: WebSocket): number {
    return countAuthed(this.openAttachments(excluding));
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
    const view = this.phoneMatches(hash) ? this.phoneViewOf(this.m) : null;
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
    const view = this.phoneViewOf({
      ...before,
      state: "ended",
      session: null,
      endReason: "canceled",
      v: applied.next.v,
    });
    return view ? { ok: true, value: view } : fail("pairing_invalid");
  }

  private async screenEvent(sid: string, ev: Event): Promise<Result<ScreenView>> {
    const auth = await this.screenAuth(sid);
    if (!auth.ok) return auth;
    const meta = this.meta as Meta;
    const applied = await this.apply(ev);
    if (!applied.ok) return applied;
    if (this.m) return { ok: true, value: this.currentScreenView() };
    // An end from waiting closed the object and its storage is gone: answer with the closed machine it committed.
    return { ok: true, value: screenView(meta, applied.next, this.config(), Date.now()) };
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
    const { collided, minted } = await runEffects(
      step.effects,
      { meta, prev: m, next: step.next, now: ev.now },
      this.deps(),
    );
    const after = this.m;
    if (!after) return { ok: true, collided, next: step.next, minted }; // closed: storage is gone
    // Only on the pairing's end: a socket opened later is still unauthed, and its hello earns pairing_invalid.
    if (m.pairing && !after.pairing) this.closePhoneSockets();
    // A demo session that ends gives its slot back at once; the screen may go on and show a new code.
    if (meta.mode === "demo" && after.state === "ended" && m.state !== "ended") {
      await directoryStub(this.env).demoRelease(meta.screenRef);
    }
    await this.rearm();
    // A drop back to waiting leaves no code; the screen gets a fresh one at once.
    if (!collided && after.state === "waiting" && !after.codes.current && m.state !== "waiting") {
      await this.issueCode();
    }
    return { ok: true, collided, next: step.next, minted };
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
    ws.serializeAttachment({ ...att, authed: true, helloAt: Date.now() } satisfies SocketAttachment);
    if (att.role === "screen") this.bindLinksUnlessLive(att.ip, ws);
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets() });
    this.sendState(ws, att.role);
    if (att.role === "screen" && this.m?.state === "waiting" && !this.m.codes.current) await this.issueCode();
    await this.rearm();
  }

  private sendState(ws: WebSocket, role: Role): void {
    const { meta, m } = this;
    if (!meta || !m) return;
    const now = Date.now();
    const view = role === "screen" ? screenView(meta, m, this.config(), now) : this.phoneViewOf(m);
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

  /** Whether the fetch came from the screen's address, and the refusal that mismatch earns under `enforce` (OPEN-02). */
  private linkIp(ipHashed: string): { ipMatch: boolean | null; binding: "link_binding_failed" | null } {
    const store = { get: () => this.ctx.storage.kv.get<string>("screenIp"), set: (ip: string) => this.bindLinksTo(ip) };
    const screenIp = holdBinding(this.authedScreens(), Date.now(), store, this.config().socketSilenceMs);
    const ipMatch = screenIp === undefined ? null : screenIp === ipHashed;
    const enforce = this.config().links.binding === "enforce";
    return { ipMatch, binding: enforce && ipMatch === false ? "link_binding_failed" : null };
  }

  /**
   * A player reads a view link in many ranges, so a row per range would let one video flood D1 (VID-02): a view link
   * writes its first fetch, and one more per foreign IP hash (`foreign`), up to MAX_AUDITED_IPS. Every other link
   * writes every fetch.
   */
  private auditsFetch(record: LinkRecord, foreign: string | null): boolean {
    if (record.purpose !== "view" || record.fetches === 1) return true;
    if (foreign === null || record.ips.includes(foreign) || record.ips.length >= MAX_AUDITED_IPS) return false;
    this.links.update(record, { ips: [...record.ips, foreign] });
    return true;
  }

  /** Audits a refusal and records a failure metric; a view link does so once, since its player retries every range. */
  private async linkRefused(
    refused: Use & { ok: false },
    now: number,
    via: LinkVia,
  ): Promise<{ ok: false; error: ErrorCode }> {
    const { m, meta } = this;
    const { error, record } = refused;
    if (error === "link_unknown" || !record || !m?.pairing || !meta) return fail(error);
    if (record.purpose === "view") {
      if (record.refused) return fail(error);
      this.links.update(record, { refused: true });
    }
    const session = refusalSession(record, m.pairing.sessionId);
    if (session) await this.auditLink(session, now, "link.refused", { cause: error, ...via });
    await bestEffort(
      metricsFor(this.env).record({
        at: now,
        mode: meta.mode,
        kind: m.pairing.kind,
        roomId: meta.roomId,
        name: "failure",
        cause: error,
      }),
    );
    return fail(error);
  }

  /** The link seams (docs/interfaces.md section 4): mint pushes the link to the screen, revoke kills them all. */
  private linkSeams(): Pick<SessionSeams, "mint" | "revokeLinks"> {
    return {
      mint: async (purpose, item) => {
        const { m, meta } = this;
        const file = m?.session && fileAt(m.session.items, item);
        if (!m?.pairing || !meta || !file) return null;
        const now = Date.now();
        const link = await mintLink(meta.screenRef, file, purpose, this.config().origin);
        this.links.add({
          tokenHash: link.tokenHash,
          purpose: link.purpose,
          item,
          mintedAt: now,
          firstFetchAt: null,
          fetches: 0,
          revoked: false,
          ips: [],
          refused: false,
          sessionId: m.pairing.sessionId,
        });
        const links: LinkSet = {
          protocol: link.purpose === "protocol" ? protocolUri(link.url) : null,
          download: link.purpose === "download" ? link.url : null,
          pdf: link.purpose === "pdf" ? link.url : null,
          view: link.purpose === "view" ? link.url : null,
        };
        this.sendOpen(item, links);
        await this.auditLink(m.pairing.sessionId, now, "link.minted", { purpose: link.purpose });
        return { item, links };
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
  private sendOpen(item: number, links: LinkSet): void {
    const frame = JSON.stringify({ v: 1, t: "open", item, links, now: Date.now() });
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
        // Gone before the first await, so an upgrade still hashing sees it at its object check (fetch).
        const meta = this.meta;
        this.m = null;
        this.meta = null;
        const release = meta?.mode === "demo" ? () => directoryStub(this.env).demoRelease(meta.screenRef) : null;
        await closeObject(release, this.ctx.getWebSockets(), async () => {
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
        });
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
    const current = await this.ctx.storage.getAlarm();
    if (due.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else {
      // A poll re-arms to the same time: reading the alarm is free, setting it is a write.
      const next = Math.min(...due);
      if (current !== next) await this.ctx.storage.setAlarm(next);
    }
  }
}
