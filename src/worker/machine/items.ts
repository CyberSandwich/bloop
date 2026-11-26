// Choosing and approving items, the guest's Open, and the links a screen asks for after approval.
import { IN_SESSION } from "../../../public/js/shared/session.js";
import {
  effectivePurpose,
  fileAt,
  type ItemDraft,
  type ItemRef,
  launchIndex,
  MAX_ITEMS,
  orderItems,
  withIds,
} from "../items.ts";
import type { EventOf, Machine, Step } from "../machine.ts";
import { type Actor, fail, MINUTE, ok, type Session } from "./step.ts";

/** A session nothing has happened in yet: not approved, nothing opened or shown. */
export const newSession = (items: ItemRef[], minted: number[]): Session => ({
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

/** `userId` is the account the approving phone is signed in as now, which may be newer than the claim's. */
function approveItems(
  m: Machine,
  now: number,
  items: readonly ItemDraft[],
  minutes: number,
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
      endsAt: now + minutes * MINUTE,
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
  return ok({ ...m, state: "choosing", pairing: { ...m.pairing, listed: ev.ids } }, [{ fx: "push", to: "both" }]);
}

export function approve(m: Machine, ev: EventOf<"approve">): Step {
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
  return approveItems(m, ev.now, ev.items, ev.minutes, "phone", ev.userId);
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
