// Pairing seam (docs/interfaces.md section 2.4): what the Screen and Directory objects offer the Worker.
import type {
  ClaimResponse,
  CodeView,
  ErrorCode,
  Kind,
  LinkResponse,
  Mode,
  OpenMode,
  PairingAccountError,
  PhoneView,
  RoomView,
  ScreenView,
  ShownCommand,
} from "../../shared/protocol.ts";
import type { ItemDraft } from "../items.ts";
import type { FileRef } from "../machine.ts";
import type { ClientClass } from "./open-path/links.ts";

/**
 * Errors are the PairError codes, plus `file_not_found` (approve), `unauthorized` (a bad sid) and
 * `internal`, and a live pick's `match_required` or `match_wrong` (phone-only AppErrors). A screen that never
 * existed or has closed answers `screen_gone`.
 */
export type Result<T, E = ErrorCode | PairingAccountError> = { ok: true; value: T } | { ok: false; error: E };

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
  /**
   * The Worker resolves `items` from the source's list; the object refuses an empty list, a repeat or more than
   * MAX_ITEMS (`bad_request`) and a live pick not yet made (`match_required`). The pairing's user stays the claim's.
   */
  approve(pid: string, items: ItemDraft[]): Promise<Result<PhoneView>>;
  /**
   * The phone's remote: what the screen should show. Absolute, so a repeat is a no-op, and a `seq` not above the
   * phone's last applied one changes nothing. The item must be a file in the approved list and the page within its
   * pages; live, the phone a confirmed owner and the item a deck, PDF or doc.
   */
  control(pid: string, command: ShownCommand): Promise<Result<PhoneView>>;
  /** The screen reports its own tap, so the phone's highlight stays true. Same rules as `control`, with its own `seq`. */
  reportShown(sid: string, command: ShownCommand): Promise<Result<ScreenView>>;
  /**
   * The session ends `seconds` from now, but never past its approval plus the mode's cap. Absolute, so a repeat sets
   * about the same end again. Approved, opening and open only (`wrong_state` otherwise), in both modes; one that
   * arrives at or after the end ends the session and answers `session_ended`.
   */
  setLength(pid: string, seconds: number): Promise<Result<PhoneView>>;
  cancel(pid: string): Promise<Result<PhoneView>>;
  restart(sid: string): Promise<Result<ScreenView>>;
  /** From waiting, there is no session: the object closes (codes removed, storage deleted, demo slot released). */
  endFromScreen(sid: string): Promise<Result<ScreenView>>;
  endFromPhone(pid: string): Promise<Result<PhoneView>>;
  /** Polling fallback. A screen poll also rotates the code when it is due, and binds links to its address `ip`. */
  screenView(sid: string, ip: string): Promise<Result<ScreenView>>;
  phoneView(pid: string): Promise<Result<PhoneView>>;
  /**
   * A phone is about to upload a file (the guest drop). Checks the room's policy and the size, moves the session to
   * `uploading` (an owner who claimed becomes a guest), and answers the session id the object belongs to.
   */
  beginDrop(pid: string, length: number): Promise<Result<{ sessionId: string }>>;
  /** The object was stored and validated: the session is `offered`. */
  dropDone(pid: string, file: FileRef): Promise<Result<PhoneView, ErrorCode>>;
  /** The upload failed or was refused: back to `claimed`, and the object is purged. */
  dropFailed(pid: string, error: ErrorCode): Promise<Result<PhoneView>>;
  /**
   * Mints one more link for an approved file (a download, the PDF or image view, or a relaunch) and pushes it to the
   * screen. `item` null is the launched item; a link item or an index out of range is `file_not_found`.
   */
  mintFallback(sid: string, mode: OpenMode, item: number | null): Promise<Result<LinkResponse>>;
  /**
   * An /f/ request arrived. Applies the link rules without counting a fetch and answers the link's purpose, so the
   * route can rate-limit before `useLink`: a refused request never spends a fetch (VID-02). Audits a refusal.
   */
  checkLink(
    tokenHash: string,
    ipHash: string,
    via: { method: string; client: ClientClass },
  ): Promise<Result<{ purpose: OpenMode }>>;
  /**
   * Applies the link rules again, counts the fetch, audits it, and moves the session to open on the first accepted
   * one. Unknown hashes answer link_unknown whatever the reason (OPEN-01).
   */
  useLink(tokenHash: string, ipHash: string, via: { method: string; client: ClientClass }): Promise<Result<UsedLink>>;
}

/** One instance. Routes typed codes; counts misses exactly (ADR 0002). */
export interface CodeDirectory {
  put(code: string, screenRef: string, expiresAt: number, demo: boolean): Promise<"ok" | "collision">;
  lookup(
    code: string,
    ipHash: string,
    now: number,
  ): Promise<{ ok: true; screenRef: string; demo: boolean } | { ok: false; error: "code_unknown" | "rate_limited" }>;
  remove(code: string): Promise<void>;
}

/** The limits on concurrent demo sessions, held in the same object as the codes. */
export interface DemoCap {
  /**
   * False when `cap` demo screens already hold a slot, or this IP hash already holds `perIp`. A slot lapses
   * after `holdMs`, when its session ends, or on release.
   */
  demoReserve(screenRef: string, ipHash: string, holdMs: number, cap: number, perIp: number): Promise<boolean>;
  demoRelease(screenRef: string): Promise<void>;
}

/**
 * The live pick's three choices (PAIR-14): the match and two decoys, in a uniform shuffle. A decoy differs from the
 * match in both digits and is not its digit swap, so a glance at either digit tells them apart, and the two decoys
 * differ. `rand(n)` answers a uniform integer in [0, n); the Screen object passes `randomInt` (ids.ts).
 */
export function drawChoices(match: string, rand: (n: number) => number): string[] {
  if (!/^\d{2}$/.test(match)) throw new RangeError("match: two digits");
  const swap = `${match[1]}${match[0]}`;
  const decoys: string[] = [];
  for (let n = 0; n < 100; n++) {
    const d = String(n).padStart(2, "0");
    if (d[0] !== match[0] && d[1] !== match[1] && d !== swap) decoys.push(d);
  }
  const first = rand(decoys.length);
  const second = rand(decoys.length - 1);
  const picks = [match, decoys[first] as string, decoys[second >= first ? second + 1 : second] as string];
  for (let i = picks.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [picks[i], picks[j]] = [picks[j] as string, picks[i] as string];
  }
  return picks;
}
