// Codes, the claim and how a pairing ends: cancel, restart, timeouts, the close of an idle screen.
import { IN_SESSION } from "../../../public/js/shared/session.js";
import type { EndReason } from "../../shared/protocol.ts";
import type { Code, Effect, EventOf, Machine, MachineConfig, Step } from "../machine.ts";
import {
  type Actor,
  close,
  closeAtFor,
  codeRemovals,
  endSession,
  fail,
  ok,
  PRE_APPROVAL,
  purgeEffects,
  SECOND,
} from "./step.ts";

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
function dropToWaiting(
  m: Machine,
  now: number,
  cfg: MachineConfig,
  reason: EndReason,
  actor: Actor,
  cause?: "match_wrong",
): Step {
  const next: Machine = {
    ...m,
    state: "waiting",
    codes: { current: null, previous: null },
    pairing: null,
    session: null,
    upload: null,
    uploadAt: null,
    offerAt: null,
    endedAt: null,
    endReason: reason,
    closeAt: closeAtFor(m.sockets, now, cfg),
  };
  const effects: Effect[] = [...codeRemovals(m.codes), ...purgeEffects(m)];
  effects.push({ fx: "audit", type: "canceled", actor, ...(cause ? { cause } : {}) }, { fx: "push", to: "both" });
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
  // Every live claim carries the pick (PAIR-14); a demo has none.
  const choices = m.mode === "live" ? (ev.choices ?? null) : null;
  if (m.mode === "live" && !(choices && validChoices(choices, ev.match))) return fail("bad_request");
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
      phoneSession: ev.userId === null ? null : (ev.phoneSession ?? null),
      passHash: ev.passHash,
      confirmed: choices === null,
      choices,
    },
    endReason: null,
    closeAt: null,
  };
  return ok(next, [
    { fx: "push", to: "both" },
    { fx: "audit", type: "claimed", actor: "phone" },
  ]);
}

/** Three distinct two-digit strings, the match among them; also step 8's shape check of a stored list. */
export const validChoices = (v: unknown, match: string): v is string[] =>
  Array.isArray(v) &&
  v.length === 3 &&
  new Set(v).size === 3 &&
  v.every((c) => typeof c === "string" && /^\d{2}$/.test(c)) &&
  v.includes(match);

/**
 * The phone's pick (PAIR-14). Right: the pairing is confirmed. Wrong: the claim drops to waiting as a cancel does, with
 * cause `match_wrong`, and the Screen object answers the phone `match_wrong`. One pick per claim: a confirmed pairing
 * and a demo one take any later pick as a no-op, in session too, so a retried match-and-approve answers as the first.
 */
export function match(m: Machine, ev: EventOf<"match">, cfg: MachineConfig): Step {
  const { pairing } = m;
  if (pairing && pairing.confirmed !== false && IN_SESSION.includes(m.state)) return ok(m);
  if (!pairing || (m.state !== "claimed" && m.state !== "choosing")) return fail("wrong_state");
  if (pairing.confirmed !== false) return ok(m);
  if (ev.choice !== pairing.match) return dropToWaiting(m, ev.now, cfg, "canceled", "phone", "match_wrong");
  return ok({ ...m, pairing: { ...pairing, confirmed: true } }, [{ fx: "push", to: "both" }]);
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

/**
 * At the start deadline, before the session's end, with nothing started: one failed-start data point with the last
 * cause seen (REL-16). The session goes on; only the deadline is spent.
 */
function startMissed(m: Machine, now: number): Step | null {
  const session = m.session;
  if (session?.startBy == null || now < session.startBy || (session.endsAt != null && now >= session.endsAt)) {
    return null;
  }
  const cause = session.startCause ?? "timeout";
  return ok({ ...m, session: { ...session, startBy: null } }, [{ fx: "start", ok: false, cause }]);
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
      return startMissed(m, now) ?? endSession(m, now, cfg, "auto", "system");
    default:
      // claimed, choosing, uploading, offered
      return dropToWaiting(m, now, cfg, "claim_timeout", "system");
  }
}
