// One Screen object per screen (ADR 0002): the single serialization point for codes, the pairing and
// the timers. It wraps the pure machine; every event is committed synchronously, then its effects run.
// Concurrency rule: async work (hashing, drawing) happens before the check-and-`apply` pair, and
// `apply` commits before its first await, so a credential cannot go stale between check and commit.
import { DurableObject } from "cloudflare:workers";
import { ERRORS } from "../../../public/js/shared/errors.js";
import type {
  ClaimResponse,
  CodeView,
  DerivedFlags,
  ErrorCode,
  LinkResponse,
  LinkSet,
  MatchResponse,
  OpenMode,
  PhoneItemExtra,
  PhoneView,
  ScreenView,
  ShownCommand,
} from "../../shared/protocol.ts";
import type { AuditEvent } from "../audit.ts";
import { type Config, configFor } from "../config.ts";
import { cancelConversion } from "../convert/cancel.ts";
import { convertDepsFor } from "../convert/deps.ts";
import type { Env } from "../env.ts";
import { MAX_FRAME_BYTES, phoneFrame, screenFrame } from "../frames.ts";
import { drawCode, drawMatch, newRef, newSecret, parseCredential, randomInt, safeEqual, sha256Hex } from "../ids.ts";
import { fileAt, type ItemDraft } from "../items.ts";
import { codeRemovals } from "../machine/step.ts";
import {
  createMachine,
  type Effect,
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
import {
  accountEndRedo,
  cookieMismatch,
  type NotesTarget,
  notesTarget,
  ownerEnd,
  type Pinned,
  pinnedUser,
} from "../seams/open-path/lookups.ts";
import {
  claimSecret,
  idemPurge,
  idemSave,
  idemStore,
  openClaim,
  type SealedClaim,
  sealClaim,
} from "../seams/pairing/idem.ts";
import {
  drawChoices,
  type IdemKey,
  type PairingStore,
  type PhoneInfo,
  type Result,
  type ScreenCreated,
  type UsedLink,
} from "../seams/pairing.ts";
import { auditFor, metricsFor } from "../stores.ts";
import { directoryStub } from "../stubs.ts";
import { type Meta, phoneView, roomView, screenView } from "../views.ts";
import { bestEffort, closeObject, type EffectDeps, noopSeams, runEffects, type SessionSeams } from "./effects.ts";
import { LinkLedger, type Use } from "./ledger.ts";
import { CORRUPT_END_KEY, type CorruptEnd, migrate, SCHEMA_KEY, SCHEMA_VERSION } from "./schema.ts";
import {
  admit,
  closeLateHellos,
  countAuthed,
  helloBinding,
  holdBinding,
  OPEN,
  StateCoalescer,
  safeSend,
  screensOf,
} from "./sockets.ts";

const HELLO_MS = 5000;
const MAX_CODE_DRAWS = 3;
const PING = '{"v":1,"t":"ping"}';
const PONG = '{"v":1,"t":"pong"}';
/** The states a screen's hello may still choose its link origin in: before any link exists (FO-01). */
const ORIGIN_STATES: readonly Machine["state"][] = ["waiting", "claimed", "choosing", "uploading", "offered"];
type Role = "screen" | "phone";
interface SocketAttachment {
  /** The coalescer's key (O10); absent on a socket hibernated from before ids were kept, which keys on itself. */
  id?: string;
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
/** Match keys are one pairing's own: a new claim's pick never replays the last one's answer. */
const matchOwner = (m: Machine | null): string | null => (m?.pairing ? `match:${m.pairing.sessionId}` : null);

export class Screen extends DurableObject<Env> implements PairingStore {
  private meta: Meta | null;
  private m: Machine | null;
  private readonly links: LinkLedger;
  /** Every frame to a socket goes through it, so a state burst coalesces and nothing passes a held state (O10). */
  private readonly out = new StateCoalescer<WebSocket>({
    keyOf: (ws) => (ws.deserializeAttachment() as SocketAttachment | null)?.id ?? ws,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.links = new LinkLedger(ctx.storage.kv);
    migrate(ctx.storage.kv);
    this.meta = ctx.storage.kv.get<Meta>("meta") ?? null;
    this.m = ctx.storage.kv.get<Machine>("machine") ?? null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    if (ctx.storage.kv.get(CORRUPT_END_KEY)) void ctx.blockConcurrencyWhile(() => this.finishCorruptEnd());
  }

  /**
   * The effects of the end step 8 made (schema.ts endCorrupt), run before any other event: its audit row, the codes'
   * removal, the push and the demo slot, then the alarm, which closes an object with no socket. The marker is cleared
   * last, so a wake that dies midway runs them again.
   */
  private async finishCorruptEnd(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const pending = kv.get<CorruptEnd>(CORRUPT_END_KEY);
    const { m, meta } = this;
    if (pending && m && meta) {
      const codes = pending.codes ?? { current: null, previous: null };
      const effects: Effect[] = [
        ...codeRemovals(codes),
        { fx: "audit", type: "ended", actor: "system" },
        { fx: "push", to: "both" },
      ];
      const now = Date.now();
      await bestEffort(runEffects(effects, { meta, prev: m, next: m, now }, this.deps()).then(() => undefined));
      idemPurge(kv);
      if (meta.mode === "demo") await bestEffort(directoryStub(this.env).demoRelease(meta.screenRef));
      await this.rearm();
    }
    kv.put(CORRUPT_END_KEY, null);
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
    const meta: Meta = { ...input, screenSecretHash, createdAt: now, linkOrigin: "file" };
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

  /**
   * A live claim stores the three choices and answers them, never the match (PAIR-14); a demo answers the match. With
   * `idem`, the answer is kept for the key, so the route's replay (`idemFind`) returns this pid, not `code_taken`.
   */
  async claim(code: string, phone: PhoneInfo, idem?: IdemKey): Promise<Result<ClaimResponse>> {
    if (!this.m || !this.meta) return fail("screen_gone");
    if (phone.kind === "guest" && this.meta.mode === "live") {
      const policy = this.config().guestDrop;
      if (policy === "off") return fail("drop_disabled");
      if (policy === "pass" && !phone.passHash) return fail("pass_required");
    }
    // With a key, the secret is derived from a stored nonce so a replay can answer the same pid without storing it.
    const pepper = this.config().hashPepper;
    const nonce = idem ? newSecret() : null;
    const secret = nonce ? await claimSecret(pepper, nonce) : newSecret();
    const secretHash = await sha256Hex(secret);
    const match = drawMatch();
    const live = this.meta.mode === "live";
    const choices = live ? drawChoices(match, randomInt) : null;
    // A demo screen never carries an account (architecture 4.5), whatever the route resolved.
    const userId = live ? phone.userId : null;
    const now = Date.now();
    const applied = await this.apply({
      e: "claim",
      now,
      code,
      sessionId: newRef(),
      secretHash,
      match,
      kind: phone.kind,
      userId,
      phoneSession: userId === null ? null : (phone.phoneSession ?? null),
      passHash: phone.passHash,
      choices,
    });
    if (!applied.ok) return applied;
    const meta = this.meta as Meta;
    const answer: ClaimResponse = {
      pid: `${meta.screenRef}.${secret}`,
      room: roomView(meta),
      match: live ? null : match,
      choices,
      mode: meta.mode,
      kind: phone.kind,
      // Auth-first refuses a signed-out owner before the claim (PAIR-15), so no claim ever needs it.
      // transitional: removed in P1 commit 8 (the field goes once a deploy has shipped it false, Q.12)
      needsAuth: false,
      dropMaxBytes: this.dropMaxBytes(),
    };
    if (idem && nonce && this.m) idemSave(this.ctx.storage.kv, idem.owner, idem, sealClaim(answer, nonce), now);
    return { ok: true, value: answer };
  }

  /** The first answer stored for a key (idem.ts's `IdemStore.find`), for the route's verdict, its pid derived again. */
  async idemFind(
    owner: string,
    keyHash: string,
    since: number,
  ): Promise<{ bodyHash: string; stored: ClaimResponse } | null> {
    const row = await idemStore<SealedClaim>(this.ctx.storage.kv).find(owner, keyHash, since);
    if (!row || !this.meta) return null;
    const stored = await openClaim(row.stored, this.meta.screenRef, this.config().hashPepper);
    return stored && { bodyHash: row.bodyHash, stored };
  }

  /**
   * The phone's pick (PAIR-14). A wrong pick answers `match_wrong`; a repeat after a right one is a no-op. With
   * `idem`, a right pick's answer is kept for the key, scoped to this pairing (a wrong one drops the pairing and its
   * rows).
   */
  async match(pid: string, choice: string, idem?: Omit<IdemKey, "owner">): Promise<Result<MatchResponse>> {
    const auth = await this.phoneAuth(pid);
    if (!auth.ok) return auth;
    if (!this.m || !this.meta) return fail("screen_gone");
    if (!this.phoneMatches(auth.hash)) return fail("pairing_invalid");
    const owner = matchOwner(this.m);
    const now = Date.now();
    const applied = await this.apply({ e: "match", now, choice });
    if (!applied.ok) return applied;
    if (!this.phoneMatches(auth.hash)) return { ok: false, error: "match_wrong" };
    const view = this.phoneResult(auth.hash);
    if (!view.ok) return view;
    const answer: MatchResponse = { view: view.value };
    if (idem && owner) idemSave(this.ctx.storage.kv, owner, idem, answer, now);
    return { ok: true, value: answer };
  }

  /** The first match answer kept for a key of this pid's pairing, for the route's verdict. */
  async matchIdemFind(
    pid: string,
    keyHash: string,
    since: number,
  ): Promise<{ bodyHash: string; stored: MatchResponse } | null> {
    const auth = await this.phoneAuth(pid);
    const owner = auth.ok && this.phoneMatches(auth.hash) ? matchOwner(this.m) : null;
    return owner ? idemStore<MatchResponse>(this.ctx.storage.kv).find(owner, keyHash, since) : null;
  }

  async listed(pid: string, ids: string[]): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "listed", now: Date.now(), ids }));
  }

  async control(pid: string, { seq, base: _, ...shown }: ShownCommand): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "control", now: Date.now(), from: "phone", seq, shown }));
  }

  async reportShown(sid: string, { seq, base, ...shown }: ShownCommand): Promise<Result<ScreenView>> {
    const ev: Event = {
      e: "control",
      now: Date.now(),
      from: "screen",
      seq,
      shown,
      // transitional: removed in P2 (the screen sends `base` on every report, REL-13; then it is required)
      ...(base === undefined ? {} : { base }),
    };
    return this.screenEvent(sid, ev);
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

  /** `cookieUser` is the route's signed-in user (null signed out); anyone but the pinned one is `pairing_invalid`. */
  async approve(pid: string, items: ItemDraft[], cookieUser: string | null): Promise<Result<PhoneView>> {
    return this.phoneEvent(
      pid,
      () => ({ e: "approve", now: Date.now(), items, minutes: this.sessionMinutes() }),
      () => (cookieMismatch(this.m, cookieUser) ? "pairing_invalid" : null),
    );
  }

  /** A guest upload's progress for the screen's pill (U's caller). Absolute, so a repeat or a late report is a no-op. */
  async uploadProgress(pid: string, bytes: number, total: number): Promise<Result<PhoneView>> {
    return this.phoneEvent(pid, () => ({ e: "upload.progress", now: Date.now(), bytes, total }));
  }

  /**
   * Conversion finished for the file with `ref` (L's or V2's caller, object to object: no credential). A ref this
   * session does not hold, or no session, changes nothing.
   */
  async derivedReady(ref: string, derived: DerivedFlags, extra: PhoneItemExtra): Promise<Result<null>> {
    if (!this.m?.session) return { ok: true, value: null };
    const applied = await this.apply({ e: "derivedReady", now: Date.now(), ref, derived, extra });
    return applied.ok || applied.error === "wrong_state" ? { ok: true, value: null } : applied;
  }

  /** Where `itemId`'s notes live, for the paired phone only (NOTES-01); a sid fails the pid's hash. Any miss is null. */
  async notesTarget(pid: string, itemId: string): Promise<NotesTarget | null> {
    const auth = await this.phoneAuth(pid);
    return auth.ok && this.phoneMatches(auth.hash) ? notesTarget(this.m, itemId) : null;
  }

  /** Whom the pairing is pinned to, for the routes' cookie check. */
  async pinnedUser(pid: string): Promise<Result<Pinned>> {
    const auth = await this.phoneAuth(pid);
    if (!auth.ok) return auth;
    const pinned = this.phoneMatches(auth.hash) ? pinnedUser(this.m) : null;
    return pinned ? { ok: true, value: pinned } : fail("pairing_invalid");
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
    const { m, meta } = this;
    const now = Date.now();
    const ev = ownerEnd(m, userId, now);
    if (ev) {
      const applied = await this.apply(ev);
      return applied.ok ? { ok: true, value: null } : applied;
    }
    const redo = accountEndRedo(m);
    if (m && meta && redo.length > 0) await runEffects(redo, { meta, prev: m, next: m, now }, this.deps());
    return { ok: true, value: null };
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
    const id = crypto.randomUUID();
    server.serializeAttachment({
      id,
      role,
      authed: false,
      helloBy: now + HELLO_MS,
      ip,
      net,
    } satisfies SocketAttachment);
    // Only the hello timeout: a bare upgrade is no socket event and never moves the close deadline.
    await this.rearm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || !this.m) return this.drop(ws, 1011, "gone");
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return this.drop(ws, 1008, "frame");
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return this.drop(ws, 1008, "frame");
    }

    if (att.role === "phone") {
      const parsed = phoneFrame.safeParse(raw);
      if (!parsed.success) return this.drop(ws, 1008, "frame");
      if (parsed.data.t === "ping") return this.out.other(ws, PONG);
      if (att.authed) return this.drop(ws, 1008, "hello");
      return this.hello(ws, att, parsed.data.pid);
    }

    const parsed = screenFrame.safeParse(raw);
    if (!parsed.success) return this.drop(ws, 1008, "frame");
    const msg = parsed.data;
    if (msg.t === "ping") return this.out.other(ws, PONG);
    if (msg.t === "hello") return att.authed ? this.drop(ws, 1008, "hello") : this.hello(ws, att, msg.sid, msg.fo);
    if (!att.authed) return this.drop(ws, 1008, "hello");

    const now = Date.now();
    const result =
      msg.t === "code.next"
        ? await this.issueCode()
        : msg.t === "open.click"
          ? await this.apply({ e: "open.click", now, minutes: this.sessionMinutes() })
          : await this.apply({ e: "launched", now, mode: msg.mode });
    if (!result.ok) this.out.other(ws, JSON.stringify({ v: 1, t: "error", code: result.error, now: Date.now() }));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  /** A socket that never authed was never counted, so its end changes nothing. */
  private async socketGone(ws: WebSocket): Promise<void> {
    this.out.gone(ws);
    if (!(ws.deserializeAttachment() as SocketAttachment | null)?.authed) return;
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets(ws) });
  }

  /** Closes a socket we chose to drop: what it held goes first, and its coalescing timer goes with it. */
  private drop(ws: WebSocket, code: number, reason: string): void {
    this.out.closing(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async alarm(): Promise<void> {
    if (!this.m) return;
    const now = Date.now();
    closeLateHellos(
      this.ctx.getWebSockets().map((ws) => ({ ws, att: ws.deserializeAttachment() as SocketAttachment | null })),
      now,
    );
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
   * Proof of the sid, by `hello` or by poll, moves the link binding (OPEN-02) unless another authed screen socket still
   * holds it (sockets.ts `helloBinding`), so a leaked sid cannot take it from a lectern that is still talking.
   */
  private bindLinksUnlessLive(ip: unknown, except?: WebSocket): void {
    const bound = helloBinding(ip, this.authedScreens(except), Date.now(), this.config().socketSilenceMs);
    if (bound !== null) this.bindLinksTo(bound);
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

  /** `refuse` runs after the pid check and before the commit, with no await between, so what it read cannot change. */
  private async phoneEvent(
    pid: string,
    event: () => Event,
    refuse: () => ErrorCode | null = () => null,
  ): Promise<Result<PhoneView>> {
    const auth = await this.phoneAuth(pid);
    if (!auth.ok) return auth;
    const { m: before, meta } = this;
    if (!before || !meta) return fail("screen_gone");
    if (!this.phoneMatches(auth.hash)) return fail("pairing_invalid");
    const refused = refuse();
    if (refused) return fail(refused);
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
    // A replayed claim must not answer a pid that no longer pairs, so its row goes with the pairing or the session.
    if ((m.pairing && !after.pairing) || (after.state === "ended" && m.state !== "ended")) {
      idemPurge(this.ctx.storage.kv);
    }
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

  private async hello(
    ws: WebSocket,
    att: SocketAttachment,
    credential: string,
    fo?: Meta["linkOrigin"],
  ): Promise<void> {
    let auth: { ok: true } | { ok: false; error: ErrorCode };
    if (att.role === "screen") {
      auth = await this.screenAuth(credential);
    } else {
      const phone = await this.phoneAuth(credential);
      auth = phone.ok && !this.phoneMatches(phone.hash) ? fail("pairing_invalid") : phone;
    }
    if (!auth.ok) {
      safeSend(ws, JSON.stringify({ v: 1, t: "error", code: auth.error, now: Date.now() }));
      return this.drop(ws, 1008, "auth");
    }
    ws.serializeAttachment({ ...att, authed: true, helloAt: Date.now() } satisfies SocketAttachment);
    if (att.role === "screen") {
      this.bindLinksUnlessLive(att.ip, ws);
      if (fo) this.chooseLinkOrigin(fo);
    }
    await this.apply({ e: "socket", now: Date.now(), open: this.openSockets() });
    this.sendState(ws, att.role);
    if (att.role === "screen" && this.m?.state === "waiting" && !this.m.codes.current) await this.issueCode();
    await this.rearm();
  }

  /**
   * FO-01: only the screen's verified hello names the origin its links use, and only before approval, so no phone,
   * link request or later hello can move links to another host.
   */
  private chooseLinkOrigin(fo: Meta["linkOrigin"]): void {
    const { meta, m } = this;
    if (!meta || !m || meta.linkOrigin === fo || !ORIGIN_STATES.includes(m.state)) return;
    this.meta = { ...meta, linkOrigin: fo };
    this.ctx.storage.kv.put("meta", this.meta);
  }

  private sendState(ws: WebSocket, role: Role): void {
    const { meta, m } = this;
    if (!meta || !m) return;
    const now = Date.now();
    const view = role === "screen" ? screenView(meta, m, this.config(), now) : this.phoneViewOf(m);
    if (view) this.out.state(ws, JSON.stringify({ v: 1, t: "state", view }));
    else this.out.other(ws, JSON.stringify({ v: 1, t: "error", code: "pairing_invalid" satisfies ErrorCode, now }));
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
    for (const ws of this.ctx.getWebSockets("phone")) this.drop(ws, 1000, "done");
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
    // The likely cause if this session never starts (REL-16); outside a session the machine refuses it, harmlessly.
    if (session === m.pairing.sessionId) await this.apply({ e: "started", now, cause: "fetch_refused" });
    // transitional: removed in P1 commit 6 (the screen's hello `fo: "main"` sends started fo_fallback, FO-01)
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
        purgeGuest(
          {
            drop: guestDropFor(this.env, this.config()),
            audit: auditFor(this.env),
            now: Date.now,
            cancelConversion: (sessionId) => cancelConversion(convertDepsFor(this.env), sessionId, 1, "guest_end"),
          },
          input,
        ),
    };
  }

  /** The `open` frame: sent once per mint to the screen sockets, never repeated in `state`. */
  private sendOpen(item: number, links: LinkSet): void {
    const frame = JSON.stringify({ v: 1, t: "open", item, links, now: Date.now() });
    for (const ws of this.ctx.getWebSockets("screen")) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      // A lost one is asked for again on the screen's next view.
      if (att?.authed) this.out.other(ws, frame);
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
        const sockets = this.ctx.getWebSockets();
        for (const ws of sockets) this.out.closing(ws);
        await closeObject(release, sockets, async () => {
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
