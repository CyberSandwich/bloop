// The pure session state machine of one screen (docs/interfaces.md section 2). No I/O, no clock, no
// randomness: the Screen object draws values, reads the clock and applies the effects, in order.
import type { EndReason, ErrorCode, FileType, Kind, Mode, OpenMode, SessionState } from "../shared/protocol.ts";

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
}

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
  /** The chosen file. Exists from `offered` (guest) or from approval; approvedAt and endsAt are null while offered. */
  session: {
    file: FileRef;
    approvedAt: number | null;
    endsAt: number | null;
    openMode: OpenMode | null;
    firstOpenAt: number | null;
    mints: number;
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
  | { e: "approve"; now: number; file: FileRef; maxMinutes: number }
  | { e: "upload.start"; now: number; timeoutSeconds: number }
  | { e: "upload.done"; now: number; file: FileRef }
  | { e: "upload.failed"; now: number; error: ErrorCode }
  | { e: "open.click"; now: number; maxMinutes: number } // the Open button on a guest offer
  | { e: "launched"; now: number; mode: OpenMode }
  | { e: "fetched"; now: number }
  | { e: "fallback"; now: number; mode: OpenMode; maxMints: number }
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
  | { fx: "mint"; purpose: OpenMode }
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
const IN_SESSION: readonly SessionState[] = ["approved", "opening", "open"];
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
  const effects: Effect[] = [...codeRemovals(m.codes)];
  if (m.state === "uploading" || m.session) effects.push({ fx: "purge", file: m.session?.file ?? null });
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
  if (m.state === "uploading" || m.session) effects.push({ fx: "purge", file: m.session?.file ?? null });
  effects.push({ fx: "audit", type: "ended", actor });
  if (m.session?.approvedAt != null) {
    effects.push({ fx: "metric", name: "session_minutes", ms: now - m.session.approvedAt });
  }
  effects.push({ fx: "push", to: "both" });
  return ok(next, effects);
}

function approveFile(m: Machine, now: number, file: FileRef, maxMinutes: number, actor: Actor): Step {
  const next: Machine = {
    ...m,
    state: "approved",
    session: {
      file,
      approvedAt: now,
      endsAt: now + maxMinutes * 60 * SECOND,
      openMode: null,
      firstOpenAt: null,
      mints: 0,
    },
    uploadAt: null,
    offerAt: null,
  };
  return ok(next, [
    { fx: "mint", purpose: "protocol" },
    { fx: "audit", type: "approved", actor },
    { fx: "push", to: "both" },
  ]);
}

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
      if (IN_SESSION.includes(m.state)) {
        return m.session?.file.ref === ev.file.ref ? ok(m) : fail("wrong_state");
      }
      if (m.state === "ended") return fail("session_ended");
      if ((m.state !== "claimed" && m.state !== "choosing") || m.pairing?.kind !== "owner") return fail("wrong_state");
      if (m.mode === "live" && !m.pairing.listed.includes(ev.file.ref)) return fail("file_not_found");
      return approveFile(m, now, ev.file, ev.maxMinutes, "phone");
    }

    case "upload.start": {
      if (m.state !== "claimed" || m.pairing?.kind !== "guest") return fail("wrong_state");
      return ok({ ...m, state: "uploading", uploadAt: now + ev.timeoutSeconds * SECOND }, [{ fx: "push", to: "both" }]);
    }

    case "upload.done": {
      if (m.state !== "uploading") return fail("wrong_state");
      const session = { file: ev.file, approvedAt: null, endsAt: null, openMode: null, firstOpenAt: null, mints: 0 };
      return ok({ ...m, state: "offered", session, uploadAt: null, offerAt: now + cfg.claimTimeoutSeconds * SECOND }, [
        { fx: "audit", type: "guest.uploaded", actor: "phone" },
        { fx: "push", to: "both" },
      ]);
    }

    case "upload.failed": {
      if (m.state !== "uploading") return fail("wrong_state");
      return ok({ ...m, state: "claimed", uploadAt: null }, [
        { fx: "audit", type: "guest.refused", actor: "phone", cause: ev.error },
        { fx: "push", to: "both" },
      ]);
    }

    case "open.click": {
      if (m.state !== "offered" || !m.session) {
        if (IN_SESSION.includes(m.state)) return ok(m);
        return fail(m.state === "ended" ? "session_ended" : "wrong_state");
      }
      return approveFile(m, now, m.session.file, ev.maxMinutes, "screen");
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

    case "fallback": {
      if ((m.state !== "opening" && m.state !== "open") || !m.session) return fail("wrong_state");
      if (m.session.mints >= ev.maxMints) return fail("mint_limit");
      return ok({ ...m, session: { ...m.session, mints: m.session.mints + 1 } }, [
        { fx: "mint", purpose: ev.mode },
        { fx: "metric", name: "fallback" },
        { fx: "push", to: "screen" },
      ]);
    }

    case "cancel":
      return PRE_APPROVAL.includes(m.state) ? dropToWaiting(m, now, cfg, "canceled", "phone") : fail("wrong_state");

    case "restart":
      return PRE_APPROVAL.includes(m.state) ? dropToWaiting(m, now, cfg, "canceled", "screen") : fail("wrong_state");

    case "end": {
      if (m.state === "ended") return ok(m);
      if (!PRE_APPROVAL.includes(m.state) && !IN_SESSION.includes(m.state)) return fail("wrong_state");
      const reason: EndReason = ev.by === "system" ? "auto" : ev.by;
      return endSession(m, now, cfg, reason, ev.by);
    }

    case "socket": {
      const closeAt = m.state === "waiting" || m.state === "ended" ? closeAtFor(ev.open, now, cfg) : null;
      return ok({ ...m, sockets: ev.open, closeAt });
    }

    case "timer": {
      const due = nextDeadline(m, cfg);
      if (due === null || now < due) return ok(m);
      switch (m.state) {
        case "waiting":
        case "ended":
          return ok({ ...m, state: "closed", codes: { current: null, previous: null }, closeAt: null }, [
            ...codeRemovals(m.codes),
            { fx: "deleteAll" },
          ]);
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
