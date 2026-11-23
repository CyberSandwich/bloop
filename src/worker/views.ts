// The two views of a session (docs/interfaces.md section 1), built from the machine. Pure.
// The views carry the approved items as `itemView` shapes them and nothing else about the source (SRC-01).
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
}

export interface ViewConfig {
  origin: string;
  machine: MachineConfig;
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
  const fallback = meta.mode === "demo" ? "Demo room" : "Unregistered screen";
  return { name: meta.roomName ?? fallback, registered: meta.roomId !== null };
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

export function screenView(meta: Meta, m: Machine, cfg: ViewConfig, now: number): ScreenView {
  return {
    state: m.state,
    mode: meta.mode,
    kind: m.pairing?.kind ?? null,
    room: roomView(meta),
    code: codeView(m, cfg, now),
    match: m.pairing && MATCH_STATES.includes(m.state) ? m.pairing.match : null,
    items: m.session?.items.map(itemView) ?? [],
    openMode: m.session?.openMode ?? null,
    endsAt: m.session?.endsAt ?? null,
    endReason: m.state === "ended" || m.state === "waiting" ? m.endReason : null,
    now,
  };
}

/** Null when no phone is paired: the caller answers `pairing_invalid`. */
export function phoneView(meta: Meta, m: Machine, now: number, dropMaxBytes: number): PhoneView | null {
  if (!m.pairing) return null;
  return {
    state: m.state,
    mode: meta.mode,
    kind: m.pairing.kind,
    room: roomView(meta),
    match: m.pairing.match,
    items: m.session?.items.map(itemView) ?? [],
    openMode: m.session?.openMode ?? null,
    endsAt: m.session?.endsAt ?? null,
    endReason: m.state === "ended" ? m.endReason : null,
    dropMaxBytes,
    now,
  };
}
