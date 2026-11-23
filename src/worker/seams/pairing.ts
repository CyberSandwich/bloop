// Pairing seam (docs/interfaces.md section 2.4): what the Screen and Directory objects offer the Worker.
import type {
  ClaimResponse,
  CodeView,
  ErrorCode,
  Kind,
  LinkSet,
  Mode,
  OpenMode,
  PhoneView,
  RoomView,
  ScreenView,
} from "../../shared/protocol.ts";
import type { FileRef } from "../machine.ts";
import type { ClientClass } from "./open-path/links.ts";

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
/** What an accepted /f/ request needs to answer: the file, the purpose of the link, and whose account reads it. */
export interface UsedLink {
  file: FileRef;
  purpose: OpenMode;
  mode: Mode;
  userId: string | null;
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
  approve(pid: string, fileId: string, file: FileRef, userId: string | null): Promise<Result<PhoneView>>;
  cancel(pid: string): Promise<Result<PhoneView>>;
  restart(sid: string): Promise<Result<ScreenView>>;
  endFromScreen(sid: string): Promise<Result<ScreenView>>;
  endFromPhone(pid: string): Promise<Result<PhoneView>>;
  /** Polling fallback. A screen poll also rotates the code when it is due. */
  screenView(sid: string): Promise<Result<ScreenView>>;
  phoneView(pid: string): Promise<Result<PhoneView>>;
  /**
   * A phone is about to upload a file (the guest drop). Checks the room's policy and the size, moves the session to
   * `uploading` (an owner who claimed becomes a guest), and answers the session id the object belongs to.
   */
  beginDrop(pid: string, length: number): Promise<Result<{ sessionId: string }>>;
  /** The object was stored and validated: the session is `offered`. */
  dropDone(pid: string, file: FileRef): Promise<Result<PhoneView>>;
  /** The upload failed or was refused: back to `claimed`, and the object is purged. */
  dropFailed(pid: string, error: ErrorCode): Promise<Result<PhoneView>>;
  /** Mints one more link for the approved file (a download, the PDF view, or a relaunch) and pushes it to the screen. */
  mintFallback(sid: string, mode: OpenMode): Promise<Result<LinkSet>>;
  /**
   * An /f/ request arrived. Applies the link rules, counts the fetch, audits it, and moves the session to
   * open on the first accepted one. Unknown hashes answer link_unknown whatever the reason (OPEN-01).
   */
  useLink(tokenHash: string, ipHash: string, via: { method: string; client: ClientClass }): Promise<Result<UsedLink>>;
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
