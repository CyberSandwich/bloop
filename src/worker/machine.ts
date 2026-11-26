// The pure session state machine of one screen (docs/interfaces.md section 2). No I/O, no clock, no
// randomness: the Screen object draws values, reads the clock and applies the effects, in order.
// The types, the dispatcher and the deadlines live here; each event's reducer lives in machine/.

import type { EndReason, ErrorCode, FileType, Kind, Mode, OpenMode, SessionState, Shown } from "../shared/protocol.ts";
import type { ItemDraft, ItemRef } from "./items.ts";
import { control, end, fetched, launched, length } from "./machine/control.ts";
import { approve, fallback, listed, openClick } from "./machine/items.ts";
import { cancel, claim, codeNext, restart, socket, timer } from "./machine/pairing.ts";
import { closeAtFor, fail, SECOND } from "./machine/step.ts";
import { uploadDone, uploadFailed, uploadStart } from "./machine/upload.ts";

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
    /** The end last written to the audit, or the approved end once a change went unaudited; absent: never changed. */
    auditedEndsAt?: number;
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
  /** Counts every applied change and rides in every view, so a client keeps the newer of two views of one state. */
  v: number;
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
  | { e: "approve"; now: number; items: ItemDraft[]; minutes: number; userId?: string | null } // minutes: the starting length
  | { e: "upload.start"; now: number; timeoutSeconds: number }
  | { e: "upload.done"; now: number; file: FileRef }
  | { e: "upload.failed"; now: number; error: ErrorCode }
  | { e: "open.click"; now: number; minutes: number } // the Open button on a guest offer
  | { e: "launched"; now: number; mode: OpenMode }
  | { e: "fetched"; now: number }
  | { e: "control"; now: number; from: Sender; seq: number; shown: Shown } // the phone's remote, or the screen's own tap
  | { e: "length"; now: number; seconds: number; maxMinutes: number } // the phone sets the end; maxMinutes: the mode's cap
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
  | "guest.deleted"
  | "session.length";
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

/** The event of one name. */
export type EventOf<K extends Event["e"]> = Extract<Event, { e: K }>;

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
    v: 0,
  };
}

/** One event applied: a changed machine counts it in `v`; a no-op returns the machine itself. */
export function transition(m: Machine, ev: Event, cfg: MachineConfig): Step {
  const step = apply(m, ev, cfg);
  return step.ok && step.next !== m ? { ...step, next: { ...step.next, v: m.v + 1 } } : step;
}

function apply(m: Machine, ev: Event, cfg: MachineConfig): Step {
  if (m.state === "closed") return fail("screen_gone");
  switch (ev.e) {
    case "code.next":
      return codeNext(m, ev, cfg);
    case "claim":
      return claim(m, ev, cfg);
    case "cancel":
      return cancel(m, ev, cfg);
    case "restart":
      return restart(m, ev, cfg);
    case "socket":
      return socket(m, ev, cfg);
    case "timer":
      return timer(m, ev, cfg, nextDeadline(m, cfg));
    case "listed":
      return listed(m, ev);
    case "approve":
      return approve(m, ev);
    case "open.click":
      return openClick(m, ev);
    case "fallback":
      return fallback(m, ev);
    case "upload.start":
      return uploadStart(m, ev);
    case "upload.done":
      return uploadDone(m, ev, cfg);
    case "upload.failed":
      return uploadFailed(m, ev);
    case "control":
      return control(m, ev);
    case "length":
      return length(m, ev, cfg);
    case "launched":
      return launched(m, ev);
    case "fetched":
      return fetched(m, ev);
    case "end":
      return end(m, ev, cfg);
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
