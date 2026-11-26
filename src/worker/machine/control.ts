// An approved session: what the screen shows, its length, the launch and first fetch, and its end.
import { IN_SESSION } from "../../../public/js/shared/session.js";
import type { EndReason, ItemKind } from "../../shared/protocol.ts";
import { type ItemRef, sameShown, shownFault, showOf } from "../items.ts";
import type { Effect, EventOf, Machine, MachineConfig, StartCause, Step } from "../machine.ts";
import {
  close,
  endSession,
  fail,
  MINUTE,
  ok,
  PRE_APPROVAL,
  SECOND,
  type Session,
  unconfirmed,
  withStart,
} from "./step.ts";

/** The kinds a live screen pages through in its viewer; anything else it only opens. */
const LIVE_VIEWER: readonly ItemKind[] = ["deck", "pdf", "doc"];

/**
 * A live session takes a command from a confirmed owner's phone, or the screen's own report (a reload resuming its
 * page), and only for an item its viewer pages through (PAIR-13).
 */
function liveRefusal(m: Machine, ev: EventOf<"control">, items: readonly ItemRef[]): "wrong_state" | null {
  if (ev.from === "phone" && (m.pairing?.kind !== "owner" || unconfirmed(m))) return "wrong_state";
  const item = items.find((i) => i.id === ev.shown.item);
  const show = item?.kind === "file" ? showOf(item) : null;
  return show !== null && LIVE_VIEWER.includes(show) ? null : "wrong_state";
}

export function control(m: Machine, ev: EventOf<"control">): Step {
  if (!IN_SESSION.includes(m.state) || !m.session || !m.pairing) return fail("wrong_state");
  const fault = shownFault(m.session.items, ev.shown, { mode: m.mode, kind: m.pairing.kind }, ev.from === "screen");
  if (fault) return fail(fault);
  const refused = m.mode === "live" ? liveRefusal(m, ev, m.session.items) : null;
  if (refused) return fail(refused);
  // Per sender, only a newer command applies: a replay, or an older one that arrives late, changes nothing.
  // Between the phone and the screen, the last one applied wins.
  // A seq is a clock in ms: one far ahead would refuse every later command from this sender.
  if (ev.seq > ev.now + 24 * 3600 * SECOND) return fail("bad_request");
  const { seq } = m.session;
  if (ev.seq <= seq[ev.from]) return ok(m);
  // Seqs order one sender only. A screen report built on a view from before the phone's latest turn is older than
  // it, so it changes nothing (REL-13); a report with no base (a client from before it) is not ordered.
  if (ev.from === "screen" && ev.base !== undefined && ev.base < (m.session.phoneV ?? 0)) return ok(m);
  const withSeq = { ...m.session, seq: { ...seq, [ev.from]: ev.seq } };
  // The screen's report is a sign the session started; the phone's command is not, since the screen may be dark.
  const { session, effects } = ev.from === "screen" ? withStart(withSeq, ev.now) : { session: withSeq, effects: [] };
  // Absolute: the same `shown` again is stored for its seq and pushes nothing.
  if (sameShown(m.session.shown, ev.shown)) return ok({ ...m, session }, effects);
  const firstShownAt = session.firstShownAt ?? ev.now;
  const phoneV = ev.from === "phone" ? { phoneV: m.v + 1 } : {};
  return ok({ ...m, session: { ...session, shown: ev.shown, firstShownAt, ...phoneV } }, [
    ...effects,
    { fx: "push", to: "both" },
  ]);
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

/** A launch hands the file to an app, which has started nothing until it fetches: the cause if none comes. */
export function launched(m: Machine, ev: EventOf<"launched">): Step {
  if (m.state !== "approved" || !m.session) return fail("wrong_state");
  const session = { ...m.session, openMode: ev.mode, ...withCause(m.session, "launch_no_fetch") };
  return ok({ ...m, state: "opening", session }, [{ fx: "push", to: "both" }]);
}

export function fetched(m: Machine, ev: EventOf<"fetched">): Step {
  const { now } = ev;
  if (m.state === "open") return ok(m);
  if ((m.state !== "approved" && m.state !== "opening") || !m.session || !m.pairing) return fail("wrong_state");
  const { approvedAt } = m.session;
  const start = withStart(m.session, now);
  const effects: Effect[] = [
    ...start.effects,
    { fx: "metric", name: "scan_to_open_ms", ms: now - m.pairing.claimedAt },
  ];
  if (approvedAt !== null) effects.push({ fx: "metric", name: "approve_to_open_ms", ms: now - approvedAt });
  effects.push({ fx: "push", to: "both" });
  return ok({ ...m, state: "open", session: { ...start.session, firstOpenAt: now } }, effects);
}

/** The cause hint, kept only while the start is still awaited. */
const withCause = (session: Session, cause: StartCause): Pick<Session, "startCause"> =>
  session.startBy != null && session.startedAt == null ? { startCause: cause } : {};

/** What the Screen object saw that the machine cannot (a refused link, links on the main origin): the latest wins. */
export function started(m: Machine, ev: EventOf<"started">): Step {
  if (!IN_SESSION.includes(m.state) || !m.session) return fail("wrong_state");
  const hint = withCause(m.session, ev.cause);
  if (hint.startCause === undefined || hint.startCause === m.session.startCause) return ok(m);
  return ok({ ...m, session: { ...m.session, ...hint } });
}

export function end(m: Machine, ev: EventOf<"end">, cfg: MachineConfig): Step {
  if (m.state === "ended") return ok(m);
  // A waiting screen has no session to end: its own End closes it, so a demo slot is free at once.
  if (m.state === "waiting" && ev.by === "screen") return close(m);
  if (!PRE_APPROVAL.includes(m.state) && !IN_SESSION.includes(m.state)) return fail("wrong_state");
  const reason: EndReason = ev.by === "system" ? "auto" : ev.by;
  return endSession(m, ev.now, cfg, reason, ev.by === "account" ? "system" : ev.by);
}
