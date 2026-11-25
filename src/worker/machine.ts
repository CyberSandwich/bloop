// The pure session state machine of one screen (docs/interfaces.md section 2). No I/O, no clock, no
// randomness: the Screen object draws values, reads the clock and applies the effects, in order.

import { IN_SESSION } from "../../public/js/shared/session.js";
import type { EndReason, ErrorCode, FileType, Kind, Mode, OpenMode, SessionState, Shown } from "../shared/protocol.ts";
import {
  effectivePurpose,
  type FileItemRef,
  fileAt,
  type ItemDraft,
  type ItemRef,
  launchIndex,
  MAX_ITEMS,
  orderItems,
  sameShown,
  shownFault,
  withIds,
} from "./items.ts";

export interface Code {
  value: string;
  issuedAt: number;
  /** Hard expiry: issuedAt + (ttl + grace). A code is never claimable at or after it. */
  expiresAt: number;
  consumed: boolean;
}
export interface FileRef {
  source: "mock" | "graph" | "guest";
  ref: string;
  name: string;
  type: FileType;
  /** Bytes, when the source said; the demo screen shows it on the file card. */
  size?: number;
}

/** Who sent a `control`: the phone's remote (pid) or the screen's own tap (sid). */
export type Sender = "phone" | "screen";

export interface Machine {
  state: SessionState;
  mode: Mode;
  codes: { current: Code | null; previous: Code | null };
  /** Issue times in the last minute. */
  codeRequests: number[];
  /** Set by a claim. Kept through `ended` (secretHash, kind, match, sessionId only) so the phone can still read "ended". */
  pairing: {
    sessionId: string;
    kind: Kind;
    match: string;
    claimedAt: number;
    secretHash: string;
    listed: string[];
    userId: string | null;
    passHash: string | null;
  } | null;
  /** The approved items, in `orderItems` order. Exists from `offered` (guest) or from approval; approvedAt and endsAt are null while offered. */
  session: {
    items: ItemRef[];
    approvedAt: number | null;
    endsAt: number | null;
    openMode: OpenMode | null;
    firstOpenAt: number | null;
    /** Links minted so far per item index, the first included (PC-02: each item gets 1 + LINK_MINTS_PER_ITEM). */
    minted: number[];
    /** What the screen shows, set by `control`; null until then. */
    shown: Shown | null;
    /** The last `control` seq applied from each sender (PAIR-13); 0 until then. */
    seq: Record<Sender, number>;
  } | null;
  uploadAt: number | null;
  offerAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  /** Only in waiting and ended, and only while no socket is open. */
  closeAt: number | null;
  /** Open WebSocket count, set by the `socket` event. */
  sockets: number;
}

export type Event =
  | { e: "code.next"; now: number; value: string } // value drawn by the caller
  | {
      e: "claim";
      now: number;
      code: string;
      sessionId: string;
      secretHash: string;
      match: string;
      kind: Kind;
      userId: string | null;
      passHash: string | null;
    }
  | { e: "listed"; now: number; ids: string[] }
  | { e: "approve"; now: number; items: ItemDraft[]; maxMinutes: number; userId?: string | null }
  | { e: "upload.start"; now: number; timeoutSeconds: number }
  | { e: "upload.done"; now: number; file: FileRef }
  | { e: "upload.failed"; now: number; error: ErrorCode }
  | { e: "open.click"; now: number; maxMinutes: number } // the Open button on a guest offer
  | { e: "launched"; now: number; mode: OpenMode }
  | { e: "fetched"; now: number }
  | { e: "control"; now: number; from: Sender; seq: number; shown: Shown } // the phone's remote, or the screen's own tap
  | { e: "fallback"; now: number; mode: OpenMode; item: number | null; maxMints: number } // null: the launched item; maxMints: per item, after its first link
  | { e: "cancel"; now: number }
  | { e: "restart"; now: number }
  | { e: "end"; now: number; by: "phone" | "screen" | "system" }
  | { e: "socket"; now: number; open: number } // open socket count
  | { e: "timer"; now: number };

export type AuditType =
  | "claimed"
  | "approved"
  | "link.minted"
  | "link.fetched"
  | "link.refused"
  | "canceled"
  | "ended"
  | "guest.uploaded"
  | "guest.refused"
  | "guest.deleted";
export type MetricName = "scan_to_open_ms" | "approve_to_open_ms" | "failure" | "fallback" | "session_minutes";

export type Effect =
  | { fx: "directory.put"; code: string; expiresAt: number }
  | { fx: "directory.remove"; code: string }
  | { fx: "push"; to: "screen" | "phone" | "both" }
  | { fx: "mint"; purpose: OpenMode; item: number }
  | { fx: "revokeLinks" }
  | { fx: "purge"; file: FileRef | null } // Residue.server
  | { fx: "audit"; type: AuditType; actor: "screen" | "phone" | "system"; cause?: ErrorCode }
  | { fx: "metric"; name: MetricName; ms?: number; cause?: ErrorCode }
  | { fx: "deleteAll" };

export type Step = { ok: true; next: Machine; effects: Effect[] } | { ok: false; error: ErrorCode };

export interface MachineConfig {
  codeTtlSeconds: number;
  codeGraceSeconds: number;
  claimTimeoutSeconds: number;
  closeAfterSeconds: number;
  maxCodesPerMinute: number;
  endedMinSeconds: number;
}

type Actor = "screen" | "phone" | "system";

const PRE_APPROVAL: readonly SessionState[] = ["claimed", "choosing", "uploading", "offered"];
const SECOND = 1000;

const ok = (next: Machine, effects: Effect[] = []): Step => ({ ok: true, next, effects });
const fail = (error: ErrorCode): Step => ({ ok: false, error });
const closeAtFor = (sockets: number, now: number, cfg: MachineConfig): number | null =>
  sockets === 0 ? now + cfg.closeAfterSeconds * SECOND : null;

export function createMachine(mode: Mode, now: number, cfg: MachineConfig): Machine {
  return {
    state: "waiting",
    mode,
    codes: { current: null, previous: null },
    codeRequests: [],
    pairing: null,
    session: null,
    uploadAt: null,
    offerAt: null,
    endedAt: null,
    endReason: null,
    closeAt: closeAtFor(0, now, cfg),
    sockets: 0,
  };
}

function codeRemovals(codes: Machine["codes"]): Effect[] {
  return [codes.current, codes.previous].flatMap((c) =>
    c ? [{ fx: "directory.remove" as const, code: c.value }] : [],
  );
}

/** The claimed code, if `value` is still claimable. The previous code lives only until `grace` after its successor. */
function findCode(m: Machine, value: string, now: number, cfg: MachineConfig): "current" | "previous" | null {
  const { current, previous } = m.codes;
  if (current?.value === value) return "current";
  if (previous?.value === value) {
    const successorGrace = current ? current.issuedAt + cfg.codeGraceSeconds * SECOND : Number.POSITIVE_INFINITY;
    return now < successorGrace ? "previous" : null;
  }
  return null;
}

/**
 * Residue.server for a guest object: by key once the session holds the file, by session id while an upload is
 * in flight (no ref yet). An owner session never stored anything, so it purges nothing.
 */
function purgeEffects(m: Machine): Effect[] {
  if (m.state === "uploading") return [{ fx: "purge", file: null }];
  const guest = m.session?.items.find((i): i is FileItemRef => i.kind === "file" && i.source === "guest");
  if (!guest) return [];
  const { kind: _, id: __, ...file } = guest;
  return [{ fx: "purge", file }];
}

type Session = NonNullable<Machine["session"]>;

/** A session nothing has happened in yet: not approved, nothing opened or shown. */
const newSession = (items: ItemRef[], minted: number[]): Session => ({
  items,
  approvedAt: null,
  endsAt: null,
  openMode: null,
  firstOpenAt: null,
  minted,
  shown: null,
  seq: { phone: 0, screen: 0 },
});

const sameRefs = (a: readonly ItemRef[], b: readonly ItemDraft[]): boolean =>
  a.length === b.length && a.every((item, i) => item.ref === b[i]?.ref);

/** Terminal: both codes retired and storage deleted (`deleteAll` also releases a demo slot). No session, so no audit. */
const close = (m: Machine): Step =>
  ok({ ...m, state: "closed", codes: { current: null, previous: null }, closeAt: null }, [
    ...codeRemovals(m.codes),
    { fx: "deleteAll" },
  ]);

/** Back to waiting with no code, no pairing and no file: cancel, restart and every claim timeout. */
function dropToWaiting(m: Machine, now: number, cfg: MachineConfig, reason: EndReason, actor: Actor): Step {
  const next: Machine = {
    ...m,
    state: "waiting",
    codes: { current: null, previous: null },
    pairing: null,
    session: null,
    uploadAt: null,
    offerAt: null,
    endedAt: null,
    endReason: reason,
    closeAt: closeAtFor(m.sockets, now, cfg),
  };
  const effects: Effect[] = [...codeRemovals(m.codes), ...purgeEffects(m)];
  effects.push({ fx: "audit", type: "canceled", actor }, { fx: "push", to: "both" });
  return ok(next, effects);
}

function endSession(m: Machine, now: number, cfg: MachineConfig, reason: EndReason, actor: Actor): Step {
  if (!m.pairing) return fail("wrong_state");
  const next: Machine = {
    ...m,
    state: "ended",
    codes: { current: null, previous: null },
    pairing: { ...m.pairing, listed: [], userId: null, passHash: null },
    session: null,
    uploadAt: null,
    offerAt: null,
    endedAt: now,
    endReason: reason,
    closeAt: closeAtFor(m.sockets, now, cfg),
  };
  const effects: Effect[] = [...codeRemovals(m.codes)];
  if (m.session?.approvedAt != null) effects.push({ fx: "revokeLinks" });
  effects.push(...purgeEffects(m), { fx: "audit", type: "ended", actor });
  if (m.session?.approvedAt != null) {
    effects.push({ fx: "metric", name: "session_minutes", ms: now - m.session.approvedAt });
  }
  effects.push({ fx: "push", to: "both" });
  return ok(next, effects);
}

/** `userId` is the account the approving phone is signed in as now, which may be newer than the claim's. */
function approveItems(
  m: Machine,
  now: number,
  items: readonly ItemDraft[],
  maxMinutes: number,
  actor: Actor,
  userId: string | null = null,
): Step {
  const ordered = withIds(orderItems(items));
  const launch = launchIndex(ordered);
  const next: Machine = {
    ...m,
    state: "approved",
    pairing: m.pairing && { ...m.pairing, userId: userId ?? m.pairing.userId },
    session: {
      ...newSession(
        ordered,
        ordered.map((_, i) => (i === launch ? 1 : 0)),
      ),
      approvedAt: now,
      endsAt: now + maxMinutes * 60 * SECOND,
    },
    uploadAt: null,
    offerAt: null,
  };
  return ok(next, [
    ...(launch < 0 ? [] : [{ fx: "mint" as const, purpose: "protocol" as const, item: launch }]),
    { fx: "audit", type: "approved", actor },
    { fx: "push", to: "both" },
  ]);
}

/** One to MAX_ITEMS items with distinct refs. */
const validItems = (items: readonly ItemDraft[]): boolean =>
  items.length >= 1 && items.length <= MAX_ITEMS && new Set(items.map((i) => i.ref)).size === items.length;

export function transition(m: Machine, ev: Event, cfg: MachineConfig): Step {
  if (m.state === "closed") return fail("screen_gone");
  const { now } = ev;

  switch (ev.e) {
    case "code.next": {
      if (m.state !== "waiting" && m.state !== "ended") return fail("wrong_state");
      const recent = m.codeRequests.filter((t) => now - t < 60 * SECOND);
      if (recent.length >= cfg.maxCodesPerMinute) return fail("rate_limited");
      if (m.state === "ended" && m.endedAt !== null && now - m.endedAt < cfg.endedMinSeconds * SECOND) {
        return fail("rate_limited");
      }
      const code: Code = {
        value: ev.value,
        issuedAt: now,
        expiresAt: now + (cfg.codeTtlSeconds + cfg.codeGraceSeconds) * SECOND,
        consumed: false,
      };
      const next: Machine = {
        ...m,
        state: "waiting",
        codes: { current: code, previous: m.codes.current },
        codeRequests: [...recent, now],
        pairing: null,
        session: null,
        endedAt: null,
        // A drop back to waiting keeps its reason through rotation; only a new session start clears it.
        endReason: m.state === "ended" ? null : m.endReason,
        closeAt: closeAtFor(m.sockets, now, cfg),
      };
      const effects: Effect[] = [{ fx: "directory.put", code: code.value, expiresAt: code.expiresAt }];
      if (m.codes.previous) effects.push({ fx: "directory.remove", code: m.codes.previous.value });
      effects.push({ fx: "push", to: "screen" });
      return ok(next, effects);
    }

    case "claim": {
      if (m.state !== "waiting") {
        const held = findCode(m, ev.code, now, cfg);
        return fail(held ? "code_taken" : "code_expired");
      }
      const slot = findCode(m, ev.code, now, cfg);
      const code = slot ? m.codes[slot] : null;
      if (!slot || !code) return fail("code_expired");
      if (code.consumed) return fail("code_taken");
      if (now >= code.expiresAt) return fail("code_expired");
      const next: Machine = {
        ...m,
        state: "claimed",
        codes: { ...m.codes, [slot]: { ...code, consumed: true } },
        pairing: {
          sessionId: ev.sessionId,
          kind: ev.kind,
          match: ev.match,
          claimedAt: now,
          secretHash: ev.secretHash,
          listed: [],
          userId: ev.userId,
          passHash: ev.passHash,
        },
        endReason: null,
        closeAt: null,
      };
      return ok(next, [
        { fx: "push", to: "both" },
        { fx: "audit", type: "claimed", actor: "phone" },
      ]);
    }

    case "listed": {
      if ((m.state !== "claimed" && m.state !== "choosing") || m.pairing?.kind !== "owner") return fail("wrong_state");
      return ok({ ...m, state: "choosing", pairing: { ...m.pairing, listed: ev.ids } }, [{ fx: "push", to: "both" }]);
    }

    case "approve": {
      if (!validItems(ev.items)) return fail("bad_request");
      if (IN_SESSION.includes(m.state)) {
        return m.session && sameRefs(m.session.items, orderItems(ev.items)) ? ok(m) : fail("wrong_state");
      }
      if (m.state === "ended") return fail("session_ended");
      if ((m.state !== "claimed" && m.state !== "choosing") || m.pairing?.kind !== "owner") return fail("wrong_state");
      const { listed } = m.pairing;
      // A live screen has no viewer: it can show only the one file it launches, so a live session takes exactly one.
      if (m.mode === "live" && (ev.items.length !== 1 || ev.items[0]?.kind !== "file")) return fail("bad_request");
      if (m.mode === "live" && !ev.items.every((i) => listed.includes(i.ref))) return fail("file_not_found");
      return approveItems(m, now, ev.items, ev.maxMinutes, "phone", ev.userId);
    }

    case "upload.start": {
      // A scan does not say what the phone will do. A phone that claimed as an owner and now sends a file
      // becomes a guest here, and gives up its list and account.
      const { pairing } = m;
      if (!pairing || (m.state !== "claimed" && m.state !== "choosing")) return fail("wrong_state");
      if (m.state === "choosing" && pairing.kind !== "owner") return fail("wrong_state");
      const guest = { ...pairing, kind: "guest" as const, listed: [], userId: null };
      return ok({ ...m, pairing: guest, state: "uploading", uploadAt: now + ev.timeoutSeconds * SECOND }, [
        { fx: "push", to: "both" },
      ]);
    }

    case "upload.done": {
      if (m.state !== "uploading") return fail("wrong_state");
      const session = newSession(withIds([{ kind: "file", ...ev.file }]), [0]);
      return ok({ ...m, state: "offered", session, uploadAt: null, offerAt: now + cfg.claimTimeoutSeconds * SECOND }, [
        { fx: "audit", type: "guest.uploaded", actor: "phone" },
        { fx: "push", to: "both" },
      ]);
    }

    case "upload.failed": {
      if (m.state !== "uploading") return fail("wrong_state");
      return ok({ ...m, state: "claimed", uploadAt: null }, [
        { fx: "audit", type: "guest.refused", actor: "phone", cause: ev.error },
        { fx: "metric", name: "failure", cause: ev.error },
        { fx: "push", to: "both" },
      ]);
    }

    case "open.click": {
      if (m.state !== "offered" || !m.session) {
        if (IN_SESSION.includes(m.state)) return ok(m);
        return fail(m.state === "ended" ? "session_ended" : "wrong_state");
      }
      return approveItems(m, now, m.session.items, ev.maxMinutes, "screen");
    }

    case "launched": {
      if (m.state !== "approved" || !m.session) return fail("wrong_state");
      return ok({ ...m, state: "opening", session: { ...m.session, openMode: ev.mode } }, [{ fx: "push", to: "both" }]);
    }

    case "fetched": {
      if (m.state === "open") return ok(m);
      if ((m.state !== "approved" && m.state !== "opening") || !m.session || !m.pairing) return fail("wrong_state");
      const { approvedAt } = m.session;
      const effects: Effect[] = [{ fx: "metric", name: "scan_to_open_ms", ms: now - m.pairing.claimedAt }];
      if (approvedAt !== null) effects.push({ fx: "metric", name: "approve_to_open_ms", ms: now - approvedAt });
      effects.push({ fx: "push", to: "both" });
      return ok({ ...m, state: "open", session: { ...m.session, firstOpenAt: now } }, effects);
    }

    case "control": {
      // A live screen has no viewer to follow a command.
      if (!IN_SESSION.includes(m.state) || !m.session || !m.pairing || m.mode === "live") return fail("wrong_state");
      const fault = shownFault(m.session.items, ev.shown, { mode: m.mode, kind: m.pairing.kind });
      if (fault) return fail(fault);
      // Per sender, only a newer command applies: a replay, or an older one that arrives late, changes nothing.
      // Between the phone and the screen, the last one applied wins.
      const { seq } = m.session;
      if (ev.seq <= seq[ev.from]) return ok(m);
      const session = { ...m.session, seq: { ...seq, [ev.from]: ev.seq } };
      // Absolute: the same `shown` again is stored for its seq and pushes nothing.
      if (sameShown(m.session.shown, ev.shown)) return ok({ ...m, session });
      return ok({ ...m, session: { ...session, shown: ev.shown } }, [{ fx: "push", to: "both" }]);
    }

    case "fallback": {
      // From `approved` the screen asks again for the protocol link it never received (a reload).
      const relaunch = ev.mode === "protocol";
      if (!IN_SESSION.includes(m.state) || !m.session || (m.state === "approved" && !relaunch)) {
        return fail("wrong_state");
      }
      // A screen can mint only for a file it was approved to show (PAIR-11): never a link, never out of range.
      const launch = launchIndex(m.session.items);
      const item = ev.item ?? launch;
      const file = fileAt(m.session.items, item);
      if (!file) return fail("file_not_found");
      // Every item's first link is free; `maxMints` counts the links after it.
      if ((m.session.minted[item] ?? 0) >= 1 + ev.maxMints) return fail("mint_limit");
      const minted = m.session.minted.map((n, i) => (i === item ? n + 1 : n));
      // openMode is how the launched item is served: another item's fallback leaves it, and it records what the
      // link serves for the type (a deck's view is its PDF), not what was asked.
      const served = relaunch || item !== launch ? m.session.openMode : effectivePurpose(file.type, ev.mode);
      const session = { ...m.session, minted, openMode: served };
      return ok({ ...m, session }, [
        { fx: "mint", purpose: ev.mode, item },
        ...(relaunch ? [] : [{ fx: "metric" as const, name: "fallback" as const }]),
        { fx: "push", to: "both" },
      ]);
    }

    case "cancel":
      return PRE_APPROVAL.includes(m.state) ? dropToWaiting(m, now, cfg, "canceled", "phone") : fail("wrong_state");

    case "restart":
      return PRE_APPROVAL.includes(m.state) ? dropToWaiting(m, now, cfg, "canceled", "screen") : fail("wrong_state");

    case "end": {
      if (m.state === "ended") return ok(m);
      // A waiting screen has no session to end: its own End closes it, so a demo slot is free at once.
      if (m.state === "waiting" && ev.by === "screen") return close(m);
      if (!PRE_APPROVAL.includes(m.state) && !IN_SESSION.includes(m.state)) return fail("wrong_state");
      const reason: EndReason = ev.by === "system" ? "auto" : ev.by;
      return endSession(m, now, cfg, reason, ev.by);
    }

    case "socket": {
      const closeAt = m.state === "waiting" || m.state === "ended" ? closeAtFor(ev.open, now, cfg) : null;
      // A poll arrives every couple of seconds and must not become a storage write each time: keep the
      // same machine until the sliding deadline is a tenth of its window stale.
      const slack = (cfg.closeAfterSeconds * SECOND) / 10;
      const unchanged =
        closeAt === m.closeAt || (closeAt !== null && m.closeAt !== null && closeAt - m.closeAt < slack);
      if (ev.open === m.sockets && unchanged) return ok(m);
      return ok({ ...m, sockets: ev.open, closeAt });
    }

    case "timer": {
      const due = nextDeadline(m, cfg);
      if (due === null || now < due) return ok(m);
      switch (m.state) {
        case "waiting":
        case "ended":
          return close(m);
        case "approved":
        case "opening":
        case "open":
          return endSession(m, now, cfg, "auto", "system");
        default:
          // claimed, choosing, uploading, offered
          return dropToWaiting(m, now, cfg, "claim_timeout", "system");
      }
    }
  }
}

/** Earliest deadline for the single alarm, or null for none (interfaces.md section 2.1). */
export function nextDeadline(m: Machine, cfg: MachineConfig): number | null {
  switch (m.state) {
    case "waiting":
    case "ended":
      return m.closeAt;
    case "claimed":
    case "choosing":
      return m.pairing ? m.pairing.claimedAt + cfg.claimTimeoutSeconds * SECOND : null;
    case "uploading":
      return m.uploadAt;
    case "offered":
      return m.offerAt;
    case "approved":
    case "opening":
    case "open":
      return m.session?.endsAt ?? null;
    case "closed":
      return null;
  }
}
