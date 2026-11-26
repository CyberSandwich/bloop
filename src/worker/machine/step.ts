// What every sub-reducer shares: the step constructors, the clock units and the pre-approval states.
import type { ErrorCode, SessionState } from "../../shared/protocol.ts";
import type { Effect, Machine, MachineConfig, Step } from "../machine.ts";

export type Actor = "screen" | "phone" | "system";
export type Session = NonNullable<Machine["session"]>;

export const PRE_APPROVAL: readonly SessionState[] = ["claimed", "choosing", "uploading", "offered"];
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

export const ok = (next: Machine, effects: Effect[] = []): Step => ({ ok: true, next, effects });
export const fail = (error: ErrorCode): Step => ({ ok: false, error });
export const closeAtFor = (sockets: number, now: number, cfg: MachineConfig): number | null =>
  sockets === 0 ? now + cfg.closeAfterSeconds * SECOND : null;
