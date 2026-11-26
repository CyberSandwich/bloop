// The two views of a session (docs/interfaces.md section 1), built from the machine. Pure.
// The views carry the approved items as `itemView` shapes them and nothing else about the source (SRC-01). Phone-only
// data (`session.extra`, the live pick's choices) is added in `phoneView` alone, so a screen view cannot carry it.
import type { Mode, PhoneView, RoomView, ScreenView, SessionState } from "../shared/protocol.ts";
import { itemView } from "./items.ts";
import type { Machine, MachineConfig } from "./machine.ts";

export interface Meta {
  screenRef: string;
  mode: Mode;
  roomId: string | null;
  roomName: string | null;
  screenSecretHash: string;
  createdAt: number;
  /** The origin the screen's links use: set only by the screen's own hello, and only before approval (FO-01). */
  linkOrigin: "file" | "main";
}

export interface ViewConfig {
  origin: string;
  machine: MachineConfig;
  library: { largeFileChoiceBytes: number };
}

const MATCH_STATES: readonly SessionState[] = [
  "claimed",
  "choosing",
  "uploading",
  "offered",
  "approved",
  "opening",
  "open",
];

export function roomView(meta: Meta): RoomView {
  // An unregistered room has no name: the phone shows the match digits instead.
  return { name: meta.roomName ?? (meta.mode === "demo" ? "Demo Room" : null), registered: meta.roomId !== null };
}

/** The code the screen shows: only while waiting, and only until its hard expiry. */
function codeView(m: Machine, cfg: ViewConfig, now: number): ScreenView["code"] {
  const code = m.codes.current;
  if (m.state !== "waiting" || !code || code.consumed || now >= code.expiresAt) return null;
  return {
    code: code.value,
    expiresAt: code.issuedAt + cfg.machine.codeTtlSeconds * 1000,
    qrUrl: `${cfg.origin}/a?c=${code.value}`,
  };
}

/** Only `false` is an open pick: no pairing reads false, and a demo or a pairing stored before the pick reads true. */
const isConfirmed = (m: Machine): boolean => m.pairing !== null && m.pairing.confirmed !== false;

export function screenView(meta: Meta, m: Machine, cfg: ViewConfig, now: number): ScreenView {
  return {
    state: m.state,
    mode: meta.mode,
    kind: m.pairing?.kind ?? null,
    room: roomView(meta),
    code: codeView(m, cfg, now),
    match: m.pairing && MATCH_STATES.includes(m.state) ? m.pairing.match : null,
    confirmed: isConfirmed(m),
    items: m.session?.items.map(itemView) ?? [],
    shown: m.session?.shown ?? null,
    openMode: m.session?.openMode ?? null,
    endsAt: m.session?.endsAt ?? null,
    endReason: m.state === "ended" || m.state === "waiting" ? m.endReason : null,
    upload: m.state === "uploading" ? (m.upload ?? null) : null,
    choiceBytes: cfg.library.largeFileChoiceBytes,
    seq: m.session?.seq.screen ?? 0,
    v: m.v,
    now,
  };
}

/** The per-mode limits a phone shows: the largest drop and the longest session. */
export interface PhoneLimits {
  dropMaxBytes: number;
  maxMinutes: number;
}

/** Null when no phone is paired: the caller answers `pairing_invalid`. */
export function phoneView(meta: Meta, m: Machine, now: number, limits: PhoneLimits): PhoneView | null {
  const { pairing, session } = m;
  if (!pairing) return null;
  const confirmed = isConfirmed(m);
  const extra = session?.extra ?? {};
  return {
    state: m.state,
    mode: meta.mode,
    kind: pairing.kind,
    room: roomView(meta),
    // Before the pick the phone holds the three choices and never the match (PAIR-14).
    match: confirmed ? pairing.match : null,
    choices: confirmed ? null : (pairing.choices ?? null),
    confirmed,
    firstShownAt: session?.firstShownAt ?? null,
    items:
      session?.items.map((i) => {
        const view = itemView(i);
        return Object.hasOwn(extra, i.id) ? { ...view, extra: extra[i.id] } : view;
      }) ?? [],
    shown: session?.shown ?? null,
    openMode: session?.openMode ?? null,
    endsAt: session?.endsAt ?? null,
    endReason: m.state === "ended" ? m.endReason : null,
    dropMaxBytes: limits.dropMaxBytes,
    maxMinutes: limits.maxMinutes,
    latestEnd: session?.approvedAt == null ? null : session.approvedAt + limits.maxMinutes * 60_000,
    seq: session?.seq.phone ?? 0,
    v: m.v,
    now,
  };
}
