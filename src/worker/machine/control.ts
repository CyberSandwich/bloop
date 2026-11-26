// An approved session: what the screen shows, its length, the launch and first fetch, and its end.
import { IN_SESSION } from "../../../public/js/shared/session.js";
import type { EndReason } from "../../shared/protocol.ts";
import { sameShown, shownFault } from "../items.ts";
import type { Effect, EventOf, Machine, MachineConfig, Step } from "../machine.ts";
import { close, endSession, fail, MINUTE, ok, PRE_APPROVAL, SECOND } from "./step.ts";

export function control(m: Machine, ev: EventOf<"control">): Step {
  // A live screen has no viewer to follow a command.
  if (!IN_SESSION.includes(m.state) || !m.session || !m.pairing || m.mode === "live") return fail("wrong_state");
  const fault = shownFault(m.session.items, ev.shown, { mode: m.mode, kind: m.pairing.kind }, ev.from === "screen");
  if (fault) return fail(fault);
  // Per sender, only a newer command applies: a replay, or an older one that arrives late, changes nothing.
  // Between the phone and the screen, the last one applied wins.
  // A seq is a clock in ms: one far ahead would refuse every later command from this sender.
  if (ev.seq > ev.now + 24 * 3600 * SECOND) return fail("bad_request");
  const { seq } = m.session;
  if (ev.seq <= seq[ev.from]) return ok(m);
  const session = { ...m.session, seq: { ...seq, [ev.from]: ev.seq } };
  // Absolute: the same `shown` again is stored for its seq and pushes nothing.
  if (sameShown(m.session.shown, ev.shown)) return ok({ ...m, session });
  return ok({ ...m, session: { ...session, shown: ev.shown } }, [{ fx: "push", to: "both" }]);
}

export function length(m: Machine, ev: EventOf<"length">, cfg: MachineConfig): Step {
  const { now } = ev;
  const session = m.session;
  if (!IN_SESSION.includes(m.state) || session?.approvedAt == null) return fail("wrong_state");
  // A late alarm leaves a session open past its end: end it as the timer would, never bring it back.
  if (session.endsAt != null && now >= session.endsAt) return endSession(m, now, cfg, "auto", "system");
  // Absolute, never a delta: a replay sets about the same end again instead of adding to it. Never past approval
  // plus the cap, so no run of changes keeps a session alive longer than the cap.
  const endsAt = Math.min(now + ev.seconds * 1000, session.approvedAt + ev.maxMinutes * MINUTE);
  if (endsAt === session.endsAt) return ok(m);
  const effects: Effect[] = [{ fx: "push", to: "both" }];
  // Measured from the end last audited (the approved end until then), so a run of small moves cannot stay unlogged.
  const base = session.auditedEndsAt ?? session.endsAt;
  const audited = base == null || Math.abs(endsAt - base) >= MINUTE;
  if (audited) effects.push({ fx: "audit", type: "session.length", actor: "phone" });
  return ok({ ...m, session: { ...session, endsAt, auditedEndsAt: audited ? endsAt : base } }, effects);
}

export function launched(m: Machine, ev: EventOf<"launched">): Step {
  if (m.state !== "approved" || !m.session) return fail("wrong_state");
  return ok({ ...m, state: "opening", session: { ...m.session, openMode: ev.mode } }, [{ fx: "push", to: "both" }]);
}

export function fetched(m: Machine, ev: EventOf<"fetched">): Step {
  const { now } = ev;
  if (m.state === "open") return ok(m);
  if ((m.state !== "approved" && m.state !== "opening") || !m.session || !m.pairing) return fail("wrong_state");
  const { approvedAt } = m.session;
  const effects: Effect[] = [{ fx: "metric", name: "scan_to_open_ms", ms: now - m.pairing.claimedAt }];
  if (approvedAt !== null) effects.push({ fx: "metric", name: "approve_to_open_ms", ms: now - approvedAt });
  effects.push({ fx: "push", to: "both" });
  return ok({ ...m, state: "open", session: { ...m.session, firstOpenAt: now } }, effects);
}

export function end(m: Machine, ev: EventOf<"end">, cfg: MachineConfig): Step {
  if (m.state === "ended") return ok(m);
  // A waiting screen has no session to end: its own End closes it, so a demo slot is free at once.
  if (m.state === "waiting" && ev.by === "screen") return close(m);
  if (!PRE_APPROVAL.includes(m.state) && !IN_SESSION.includes(m.state)) return fail("wrong_state");
  const reason: EndReason = ev.by === "system" ? "auto" : ev.by;
  return endSession(m, ev.now, cfg, reason, ev.by);
}
