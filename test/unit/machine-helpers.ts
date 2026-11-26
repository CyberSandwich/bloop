import type { Kind, Mode } from "../../src/shared/protocol.ts";
import type { FileItemRef, LinkRef } from "../../src/worker/items.ts";
import {
  createMachine,
  type Effect,
  type Event,
  type FileRef,
  type Machine,
  type MachineConfig,
  transition,
} from "../../src/worker/machine.ts";

export const CFG: MachineConfig = {
  codeTtlSeconds: 60,
  codeGraceSeconds: 10,
  claimTimeoutSeconds: 300,
  closeAfterSeconds: 600,
  maxCodesPerMinute: 6,
  endedMinSeconds: 3,
};
export const MAX_MINUTES = 90;
export const T0 = 1_000_000;
export const sec = (n: number) => n * 1000;

export const DECK: FileRef = { source: "mock", ref: "deck-1", name: "Deck.pptx", type: "pptx" };
export const GUEST_FILE: FileRef = { source: "guest", ref: "g/abc", name: "Guest.pptx", type: "pptx", size: 2048 };
/** An item as the approve event carries it, before approval gives it an id. */
export const asItem = (file: FileRef): Omit<FileItemRef, "id"> => ({ kind: "file", ...file });
/** The same item as a session stores it. */
export const asStored = (file: FileRef, id = "i1"): FileItemRef => ({ kind: "file", id, ...file });
export const VEVOX: Omit<LinkRef, "id"> = {
  kind: "link",
  ref: "demo-vevox",
  url: "https://www.vevox.com/",
  title: "Vevox",
};

/** Applies one event and demands success. */
export function must(m: Machine, ev: Event): { next: Machine; effects: Effect[] } {
  const step = transition(m, ev, CFG);
  if (!step.ok) throw new Error(`${ev.e} refused: ${step.error}`);
  return step;
}

export const fx = (effects: Effect[], name: Effect["fx"]) => effects.filter((e) => e.fx === name);

/** A machine in waiting with one code, issued at `now`. */
export function waiting(mode: Mode = "demo", code = "AAAAAA", now = T0): Machine {
  const m = createMachine(mode, now, CFG);
  return must(m, { e: "code.next", now, value: code }).next;
}

export function claim(m: Machine, kind: Kind = "owner", now = T0 + sec(1), code = "AAAAAA", sessionId = "s1"): Machine {
  return must(m, {
    e: "claim",
    now,
    code,
    sessionId,
    secretHash: "hash",
    match: "42",
    kind,
    userId: null,
    passHash: null,
  }).next;
}

export const claimedOwner = (mode: Mode = "demo") => claim(waiting(mode));
export const claimedGuest = () => claim(waiting("demo"), "guest");

export function approved(now = T0 + sec(10)): Machine {
  return must(claimedOwner(), { e: "approve", now, items: [asItem(DECK)], minutes: MAX_MINUTES }).next;
}

/** The start deadline spent (REL-16), so the next deadline is the session's end. */
export function pastStart(m: Machine): Machine {
  const by = m.session?.startBy;
  return by == null ? m : must(m, { e: "timer", now: by }).next;
}

export function offered(now = T0 + sec(10)): Machine {
  const up = must(claimedGuest(), { e: "upload.start", now, timeoutSeconds: 900 }).next;
  return must(up, { e: "upload.done", now: now + sec(1), file: GUEST_FILE }).next;
}

export function ended(now = T0 + sec(20)): Machine {
  return must(approved(), { e: "end", now, by: "phone" }).next;
}

export function closed(): Machine {
  const m = waiting();
  return must(m, { e: "timer", now: m.closeAt as number }).next;
}

/** Field consistency per state. An empty list means the machine is valid. */
export function violations(m: Machine): string[] {
  const out: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) out.push(`${m.state}: ${msg}`);
  };
  const live = m.state === "approved" || m.state === "opening" || m.state === "open";
  const paired = ["claimed", "choosing", "uploading", "offered"].includes(m.state) || live;
  need(!paired || m.pairing !== null, "pairing required");
  need(m.state !== "waiting" || (m.pairing === null && m.session === null), "waiting holds no pairing or session");
  need(m.state !== "ended" || (m.endedAt !== null && m.endReason !== null && m.session === null), "ended record");
  need(m.state !== "ended" || m.pairing === null || m.pairing.listed.length === 0, "ended keeps no listed ids");
  need(m.state !== "uploading" || m.uploadAt !== null, "uploadAt required");
  need(m.state !== "offered" || (m.offerAt !== null && m.session?.approvedAt === null), "offer record");
  need(!live || (m.session !== null && m.session.approvedAt !== null && m.session.endsAt !== null), "session required");
  need(m.state !== "opening" || m.session?.openMode != null, "openMode set once opening");
  need(m.state !== "open" || m.session?.firstOpenAt != null, "firstOpenAt set once open");
  need(paired || m.session === null, "no session outside an active state");
  need(m.state !== "closed" || m.closeAt === null, "closed has no deadline");
  need(m.closeAt === null || m.state === "waiting" || m.state === "ended", "closeAt only in waiting and ended");
  need(m.closeAt === null || m.sockets === 0, "closeAt only with no socket open");
  need(m.state !== "claimed" || m.pairing?.listed.length === 0, "claimed lists nothing yet");
  return out;
}
