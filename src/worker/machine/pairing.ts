// Codes, the claim and how a pairing ends: cancel, restart, timeouts, the close of an idle screen.
import type { EndReason } from "../../shared/protocol.ts";
import type { FileItemRef } from "../items.ts";
import type { Code, Effect, EventOf, Machine, MachineConfig, Step } from "../machine.ts";
import { type Actor, closeAtFor, fail, ok, PRE_APPROVAL, SECOND } from "./step.ts";

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

/** Terminal: both codes retired and storage deleted (`deleteAll` also releases a demo slot). No session, so no audit. */
export const close = (m: Machine): Step =>
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

export function endSession(m: Machine, now: number, cfg: MachineConfig, reason: EndReason, actor: Actor): Step {
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

export function codeNext(m: Machine, ev: EventOf<"code.next">, cfg: MachineConfig): Step {
  const { now } = ev;
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

export function claim(m: Machine, ev: EventOf<"claim">, cfg: MachineConfig): Step {
  const { now } = ev;
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

export const cancel = (m: Machine, ev: EventOf<"cancel">, cfg: MachineConfig): Step =>
  PRE_APPROVAL.includes(m.state) ? dropToWaiting(m, ev.now, cfg, "canceled", "phone") : fail("wrong_state");

export const restart = (m: Machine, ev: EventOf<"restart">, cfg: MachineConfig): Step =>
  PRE_APPROVAL.includes(m.state) ? dropToWaiting(m, ev.now, cfg, "canceled", "screen") : fail("wrong_state");

export function socket(m: Machine, ev: EventOf<"socket">, cfg: MachineConfig): Step {
  const closeAt = m.state === "waiting" || m.state === "ended" ? closeAtFor(ev.open, ev.now, cfg) : null;
  // A poll arrives every couple of seconds and must not become a storage write each time: keep the
  // same machine until the sliding deadline is a tenth of its window stale.
  const slack = (cfg.closeAfterSeconds * SECOND) / 10;
  const unchanged = closeAt === m.closeAt || (closeAt !== null && m.closeAt !== null && closeAt - m.closeAt < slack);
  if (ev.open === m.sockets && unchanged) return ok(m);
  return ok({ ...m, sockets: ev.open, closeAt });
}

/** `due` is the machine's `nextDeadline`, which the dispatcher owns. */
export function timer(m: Machine, ev: EventOf<"timer">, cfg: MachineConfig, due: number | null): Step {
  const { now } = ev;
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
