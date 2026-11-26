// Choosing and approving items, the guest's Open, and the links a screen asks for after approval.
import { IN_SESSION } from "../../../public/js/shared/session.js";
import {
  effectivePurpose,
  fileAt,
  type ItemDraft,
  type ItemRef,
  isUpNext,
  launchIndex,
  MAX_ITEMS,
  orderItems,
  validDerived,
  validExtra,
  withIds,
} from "../items.ts";
import type { EventOf, Machine, Step } from "../machine.ts";
import { type Actor, fail, MINUTE, newSession, ok, SECOND, START_SECONDS, unconfirmed } from "./step.ts";

const sameRefs = (a: readonly ItemRef[], b: readonly ItemDraft[]): boolean =>
  a.length === b.length && a.every((item, i) => item.ref === b[i]?.ref);

/** The pairing's user is the claim's and never changes here: a pinned user is final (ADR 0015). */
function approveItems(m: Machine, now: number, items: readonly ItemDraft[], minutes: number, actor: Actor): Step {
  const ordered = withIds(orderItems(items));
  const launch = launchIndex(ordered);
  const next: Machine = {
    ...m,
    state: "approved",
    session: {
      ...newSession(
        ordered,
        ordered.map((_, i) => (i === launch ? 1 : 0)),
      ),
      approvedAt: now,
      endsAt: now + minutes * MINUTE,
      startedAt: null,
      startBy: now + START_SECONDS * SECOND,
      startCause: null,
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

export function listed(m: Machine, ev: EventOf<"listed">): Step {
  if ((m.state !== "claimed" && m.state !== "choosing") || m.pairing?.kind !== "owner") return fail("wrong_state");
  if (unconfirmed(m)) return fail("match_required");
  return ok({ ...m, state: "choosing", pairing: { ...m.pairing, listed: ev.ids } }, [{ fx: "push", to: "both" }]);
}

export function approve(m: Machine, ev: EventOf<"approve">): Step {
  if (!validItems(ev.items)) return fail("bad_request");
  if (IN_SESSION.includes(m.state)) {
    return m.session && sameRefs(m.session.items, orderItems(ev.items)) ? ok(m) : fail("wrong_state");
  }
  if (m.state === "ended") return fail("session_ended");
  if ((m.state !== "claimed" && m.state !== "choosing") || m.pairing?.kind !== "owner") return fail("wrong_state");
  if (unconfirmed(m)) return fail("match_required");
  // A live Up Next list was checked by the route's serving predicate; the machine holds no library to check it against.
  if (m.mode === "live" && !isUpNext(ev.items)) {
    // transitional: removed in P1 commit 5 (one listed mock or Graph file, until the library is the live source)
    const { listed } = m.pairing;
    if (ev.items.length !== 1 || ev.items[0]?.kind !== "file") return fail("bad_request");
    if (!ev.items.every((i) => listed.includes(i.ref))) return fail("file_not_found");
  }
  return approveItems(m, ev.now, ev.items, ev.minutes, "phone");
}

export function openClick(m: Machine, ev: EventOf<"open.click">): Step {
  if (m.state !== "offered" || !m.session) {
    if (IN_SESSION.includes(m.state)) return ok(m);
    return fail(m.state === "ended" ? "session_ended" : "wrong_state");
  }
  return approveItems(m, ev.now, m.session.items, ev.minutes, "screen");
}

export function fallback(m: Machine, ev: EventOf<"fallback">): Step {
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

/**
 * Conversion finished for the file with `ref`: its derived flags join the item, its phone-only extras join
 * `session.extra`. A ref no item holds is a stale call and changes nothing.
 */
export function derivedReady(m: Machine, ev: EventOf<"derivedReady">): Step {
  if (!validDerived(ev.derived) || !validExtra(ev.extra)) return fail("bad_request");
  const { session } = m;
  if (!IN_SESSION.includes(m.state) || !session) return fail("wrong_state");
  const item = session.items.find((i) => i.kind === "file" && i.ref === ev.ref);
  if (!item) return ok(m);
  const items = session.items.map((i) => (i === item ? { ...i, derived: ev.derived } : i));
  const extra = { ...session.extra, [item.id]: ev.extra };
  return ok({ ...m, session: { ...session, items, extra } }, [{ fx: "push", to: "both" }]);
}
