// Pairing seam (docs/interfaces.md section 2.4): what the Screen and Directory objects offer the Worker.
// Link minting and use (mintFallback, useLink) belong to the open path and are added with it.
import type {
  ClaimResponse,
  CodeView,
  ErrorCode,
  Kind,
  Mode,
  PhoneView,
  RoomView,
  ScreenView,
} from "../../shared/protocol.ts";
import type { FileRef } from "../machine.ts";

/**
 * Errors are the PairError codes, plus `file_not_found` (approve), `unauthorized` (a bad sid) and
 * `internal`. A screen that never existed or has closed answers `screen_gone`.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };

export interface ScreenCreated {
  sid: string;
  room: RoomView;
  view: ScreenView;
}
export interface PhoneInfo {
  kind: Kind;
  ipHash: string;
  userId: string | null;
  passHash: string | null;
}

/**
 * One per screen. sid = screenRef + "." + screenSecret; pid = screenRef + "." + pairingSecret.
 * Methods take the full credential string; the object checks its secret half against a stored hash.
 */
export interface PairingStore {
  create(input: {
    screenRef: string;
    mode: Mode;
    roomId: string | null;
    roomName: string | null;
  }): Promise<Result<ScreenCreated>>;
  nextCode(sid: string): Promise<Result<CodeView>>;
  claim(code: string, phone: PhoneInfo): Promise<Result<ClaimResponse>>;
  listed(pid: string, ids: string[]): Promise<Result<PhoneView>>;
  /** The Worker resolves `file` from the FileSource; the object checks `fileId` against the listed ids (live). */
  approve(pid: string, fileId: string, file: FileRef): Promise<Result<PhoneView>>;
  cancel(pid: string): Promise<Result<PhoneView>>;
  restart(sid: string): Promise<Result<ScreenView>>;
  endFromScreen(sid: string): Promise<Result<ScreenView>>;
  endFromPhone(pid: string): Promise<Result<PhoneView>>;
  /** Polling fallback. A screen poll also rotates the code when it is due. */
  screenView(sid: string): Promise<Result<ScreenView>>;
  phoneView(pid: string): Promise<Result<PhoneView>>;
}

/** One instance. Routes typed codes; counts misses exactly (ADR 0002). */
export interface CodeDirectory {
  put(code: string, screenRef: string, expiresAt: number): Promise<"ok" | "collision">;
  lookup(
    code: string,
    ipHash: string,
    now: number,
  ): Promise<{ ok: true; screenRef: string } | { ok: false; error: "code_unknown" | "rate_limited" }>;
  remove(code: string): Promise<void>;
}
