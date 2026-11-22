# bloop interfaces

The contracts for the five seams (pairing, file source, open path, guest drop, residue), plus audit and metrics. Each block names the file it belongs in. Types are TypeScript. Browser code imports the `src/shared/protocol.ts` types through JSDoc (`/** @import {ScreenView} from "../../src/shared/protocol.ts" */`, from `public/js/`). Runtime code shared by the browser and the Worker lives in `public/js/shared/` as plain JSDoc-typed ES modules, and the Worker imports it by relative path. No type from Cloudflare, Graph or R2 crosses a seam: adapters translate at the edge, so the Node exit path (ADR 0001) rewrites adapters only.

## 1. Shared protocol (`src/shared/protocol.ts`, type-only contracts, never served)
```ts
export type Mode = "live" | "demo";
export type Kind = "owner" | "guest";
export type FileType = "pptx" | "pdf";
export type OpenMode = "protocol" | "download" | "pdf";
export type EndReason = "phone" | "screen" | "auto" | "canceled" | "claim_timeout" | "error";
export type Actor = "screen" | "phone" | "system" | "host" | "it";

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/** Session states owned by the Screen object (section 2). */
export type SessionState =
  | "waiting" | "claimed" | "choosing" | "uploading" | "offered"
  | "approved" | "opening" | "open" | "ended" | "closed";

export interface RoomView { name: string; registered: boolean; }
export interface CodeView { code: string; expiresAt: number; qrUrl: string; }

export interface ScreenView {
  state: SessionState;
  mode: Mode;
  kind: Kind | null;
  room: RoomView;
  code: CodeView | null;       // only in "waiting" and "ended"
  match: string | null;        // 2 digits, from "claimed" to "open"
  fileName: string | null;     // display name, from "offered" (guest) or "approved"
  openMode: OpenMode | null;
  endsAt: number | null;
  endReason: EndReason | null;
  now: number;
}

export interface PhoneView {
  state: SessionState;
  mode: Mode;
  kind: Kind;
  room: RoomView;
  match: string;
  fileName: string | null;
  openMode: OpenMode | null;
  endsAt: number | null;
  endReason: EndReason | null;
  now: number;
}

export interface LinkSet { protocol: string; download: string; pdf: string | null; }

// WebSocket frames, all {v: 1, t: ...}, at most 4 KB.
export type ScreenMsgIn =
  | { v: 1; t: "hello"; sid: string }
  | { v: 1; t: "code.next" }
  | { v: 1; t: "open.click" }      // the Open button on a guest offer
  | { v: 1; t: "launched"; mode: OpenMode }
  | { v: 1; t: "ping" };
export type ScreenMsgOut =
  | { v: 1; t: "state"; view: ScreenView }
  | { v: 1; t: "open"; links: LinkSet; now: number }
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };
export type PhoneMsgIn = { v: 1; t: "hello"; pid: string } | { v: 1; t: "ping" };
export type PhoneMsgOut =
  | { v: 1; t: "state"; view: PhoneView }
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };

export interface ClaimRequest { code: string; pass?: string; }
export interface ClaimResponse {
  pid: string; room: RoomView; match: string; mode: Mode; kind: Kind; needsAuth: boolean;
}
export interface FileEntry {
  id: string;                  // opaque to the phone; never a Graph URL
  name: string;                // display name
  type: FileType;
  modifiedAt: number;
  size: number | null;
}

export type PairError =
  | "code_malformed" | "code_unknown" | "code_expired" | "code_taken"
  | "rate_limited" | "pairing_invalid" | "screen_gone" | "wrong_state" | "session_ended";
export type SourceError =
  | "auth_required" | "admin_consent_required" | "consent_declined" | "no_files"
  | "file_not_found" | "file_type_refused" | "source_throttled" | "source_unavailable";
export type OpenError =
  | "link_unknown" | "link_expired" | "link_exhausted" | "link_revoked"
  | "link_binding_failed" | "upstream_failed" | "launch_timeout" | "pdf_unavailable" | "mint_limit";
export type DropError =
  | "drop_disabled" | "pass_required" | "pass_invalid" | "length_required" | "too_large"
  | "bad_type" | "bad_structure" | "macro_content" | "storage_full" | "upload_aborted"
  | "already_uploaded";
export type HttpError =
  | "bad_request" | "unsupported_media_type" | "forbidden_origin" | "unauthorized"
  | "not_found" | "method_not_allowed" | "internal";
export type ClientError = "offline" | "service_down";
export type ErrorCode = PairError | SourceError | OpenError | DropError | HttpError | ClientError;

/** Body of every error response (application/problem+json). */
export interface Problem { type: "about:blank"; status: number; code: ErrorCode; }

// User-facing state keys: the slots in the shared state strings (design.md section 7).
export type PhoneStateKey =
  | "checking" | "match" | "choose" | "approve" | "approve_demo" | "unregistered" | "first_use"
  | "needs_admin" | "empty" | "approving" | "opening" | "open" | "open_fallback" | "pdf_fallback"
  | "ended" | "canceled" | "expired" | "taken" | "offline" | "error" | "guest_choose"
  | "guest_confirm" | "guest_sending" | "guest_refused" | "typed_wrong" | "framed"
  | "rate_limited" | "guest_pass_needed" | "busy";          // last three: new strings, section 9
export type ScreenStateKey =
  | "waiting" | "scanned" | "choosing" | "approved" | "opening" | "open" | "open_fallback"
  | "pdf_fallback" | "guest_open" | "ended" | "offline" | "service_down" | "error" | "phone_width";
```

## 2. Pairing and the session state machine

### 2.1 States, events and timers
- One Screen object runs one session at a time. `waiting` is the gap between sessions, `ended` lasts until the screen asks for a new code, and `closed` is terminal: storage is deleted.
- Timers come from one alarm, set to the earliest deadline the state carries:

| state | deadline | on expiry |
|---|---|---|
| waiting | `closeAt` = last socket close + 10 min (only when no socket is open) | `closed` |
| claimed, choosing | `claimAt` = claimedAt + `CLAIM_TIMEOUT_SECONDS` | `waiting` (end reason `claim_timeout`) |
| uploading | `uploadAt` = upload start + `UPLOAD_TIMEOUT_SECONDS` | `waiting` (`claim_timeout`), object deleted |
| offered | `offerAt` = offeredAt + `CLAIM_TIMEOUT_SECONDS` | `waiting` (`claim_timeout`), object deleted |
| approved, opening, open | `endsAt` = approvedAt + `SESSION_MAX_MINUTES` (demo: `DEMO_SESSION_MINUTES`) | `ended` (`auto`) |
| ended | `closeAt` as in waiting | `closed` |

- Code expiry is not a timer. A code is valid while `now < expiresAt`, which is `issuedAt + CODE_TTL_SECONDS + CODE_GRACE_SECONDS`. The screen asks for the next code every `CODE_TTL_SECONDS`, and the previous code stays claimable through its grace.

### 2.2 Transition table
| from | event | guard | to | effects |
|---|---|---|---|---|
| waiting, ended | `code.next` | at most 6 per min; ended for at least 3 s | waiting | issue code, Directory put, push screen `state` |
| waiting | `claim(code)` | code is current or previous, unconsumed, unexpired | claimed | consume code; pairing secret, match code; push both; audit `claimed` |
| waiting | `claim(code, pass)` | as above, plus a pass valid for this room | claimed (kind guest) | as above; mark the pass used |
| claimed | `listed(ids)` | owner kind | choosing | store ids; push both |
| claimed, choosing | `approve(fileId)` | fileId in stored ids (live) or fixture id (demo) | approved | session id, `endsAt`, mint link; push screen `open`; audit `approved` |
| claimed | `upload.start` | guest kind, policy allows it, no file yet | uploading | set `uploadAt` |
| uploading | `upload.done(file)` | validated | offered | store the R2 ref and `offerAt`; push screen `guest_open` (file name, Open); audit `guest.uploaded` |
| offered | `open.click` | from the screen | approved | as approve: session id, `endsAt`, mint link; push screen `open`; audit `approved` |
| uploading | `upload.failed(e)` | | claimed | delete object; push phone `error(e)`; audit `guest.refused` |
| approved | `launched(mode)` | from the screen | opening | record mode; metric |
| approved, opening | `fetched(link)` | first fetch of any link | open | `first_open_at`; metric `scan_to_open_ms`; push both |
| opening, open | `fallback(mode)` | mints left | (same) | mint a link for `mode`; push screen `open` |
| claimed, choosing, uploading, offered | `cancel` | from the phone | waiting | end reason `canceled`; audit; delete any object |
| claimed, choosing, uploading, offered | `restart` | from the screen ("Start Over") | waiting | end reason `canceled`, actor screen; audit; delete any object |
| approved, opening, open | `end(by)` | | ended | revoke links; residue purge; audit `ended`; metric; push both |
| claimed to offered | `end(by)` | | ended | as above, no session row change beyond `ended_at` |
| any timer state | `timer(now)` | deadline passed | per 2.1 | per 2.1 |
| ended, waiting | `timer(now)` | `closeAt` passed, no socket | closed | `deleteAll()` |
| closed | any | | closed | every call returns `screen_gone` |

An event the table does not list for a state returns `wrong_state` and changes nothing. Approve, cancel and end are idempotent: a repeat in the target state returns the current view.

### 2.3 The pure machine (`src/worker/machine.ts`)
```ts
import type { EndReason, ErrorCode, FileType, Kind, Mode, OpenMode, SessionState } from "../shared/protocol.ts";

export interface Code { value: string; issuedAt: number; expiresAt: number; consumed: boolean; }
export interface FileRef { source: "mock" | "graph" | "guest"; ref: string; name: string; type: FileType; }

export interface Machine {
  state: SessionState;
  mode: Mode;
  codes: { current: Code | null; previous: Code | null };
  codeRequests: number[];            // issue times in the last minute
  pairing: {
    kind: Kind; match: string; claimedAt: number; secretHash: string;
    listed: string[]; userId: string | null; passHash: string | null;
  } | null;
  session: {
    id: string; approvedAt: number; endsAt: number; file: FileRef;
    openMode: OpenMode | null; firstOpenAt: number | null; mints: number;
  } | null;
  uploadAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  closeAt: number | null;
}

export type Event =
  | { e: "code.next"; now: number; value: string }                      // value drawn by the caller
  | { e: "claim"; now: number; code: string; secretHash: string; match: string;
      kind: Kind; userId: string | null; passHash: string | null }
  | { e: "listed"; now: number; ids: string[] }
  | { e: "approve"; now: number; sessionId: string; file: FileRef; maxMinutes: number }
  | { e: "upload.start"; now: number; timeoutSeconds: number }
  | { e: "upload.done"; now: number; sessionId: string; file: FileRef; maxMinutes: number }
  | { e: "upload.failed"; now: number; error: ErrorCode }
  | { e: "launched"; now: number; mode: OpenMode }
  | { e: "fetched"; now: number }
  | { e: "fallback"; now: number; mode: OpenMode; maxMints: number }
  | { e: "cancel"; now: number }
  | { e: "restart"; now: number }
  | { e: "end"; now: number; by: "phone" | "screen" | "system" }
  | { e: "socket"; now: number; open: number }                          // open socket count
  | { e: "timer"; now: number };

export type Effect =
  | { fx: "directory.put"; code: string; expiresAt: number }
  | { fx: "push"; to: "screen" | "phone" | "both" }
  | { fx: "mint"; purpose: OpenMode }
  | { fx: "revokeLinks" }
  | { fx: "purge"; file: FileRef | null }                              // Residue.server
  | { fx: "audit"; type: AuditType; actor: "screen" | "phone" | "system" }
  | { fx: "metric"; name: MetricName; ms?: number; cause?: ErrorCode }
  | { fx: "deleteAll" };

export type AuditType =
  | "claimed" | "approved" | "link.minted" | "link.fetched" | "link.refused" | "canceled"
  | "ended" | "guest.uploaded" | "guest.refused" | "guest.deleted";
export type MetricName =
  | "scan_to_open_ms" | "approve_to_open_ms" | "failure" | "fallback" | "session_minutes";

export type Step = { ok: true; next: Machine; effects: Effect[] } | { ok: false; error: ErrorCode };

/** Pure: no I/O, no clock, no randomness. The Screen object applies effects in order. */
export type Transition = (m: Machine, ev: Event, cfg: MachineConfig) => Step;

/** Earliest deadline for the single alarm, or null for none. */
export type NextDeadline = (m: Machine) => number | null;

export interface MachineConfig {
  codeTtlSeconds: number; codeGraceSeconds: number; claimTimeoutSeconds: number;
  closeAfterSeconds: number; maxCodesPerMinute: number; endedMinSeconds: number;
}
```

### 2.4 `PairingStore` (`src/worker/seams/pairing.ts`), implemented by the Screen object
```ts
import type {
  ClaimResponse, CodeView, ErrorCode, LinkSet, Mode, OpenMode, PairError, PhoneView, RoomView, ScreenView,
} from "../../shared/protocol.ts";
import type { FileRef } from "../machine.ts";

export interface ScreenCreated { sid: string; room: RoomView; view: ScreenView; }
export interface PhoneInfo { ipHash: string; userId: string | null; passHash: string | null; }

/** One per screen. sid = screenRef + "." + screenSecret; pid = screenRef + "." + pairingSecret. */
export interface PairingStore {
  create(input: { mode: Mode; roomId: string | null; roomName: string | null }): Promise<ScreenCreated>;
  nextCode(sid: string): Promise<Result<CodeView, PairError>>;
  claim(code: string, phone: PhoneInfo): Promise<Result<ClaimResponse, PairError>>;
  listed(pid: string, ids: string[]): Promise<Result<PhoneView, PairError>>;
  approve(pid: string, fileId: string, resolveRef: (id: string) => FileRef | null):
    Promise<Result<PhoneView, PairError | "file_not_found">>;
  cancel(pid: string): Promise<Result<PhoneView, PairError>>;
  restart(sid: string): Promise<Result<ScreenView, PairError>>;
  end(credential: { sid: string } | { pid: string }): Promise<Result<ScreenView, PairError>>;
  mintFallback(sid: string, mode: Exclude<OpenMode, "protocol">): Promise<Result<LinkSet, PairError | "mint_limit">>;
  useLink(tokenHash: string, ipHash: string): Promise<Result<FileRef, OpenErrorForLink>>;
  screenView(sid: string): Promise<Result<ScreenView, PairError>>;
  phoneView(pid: string): Promise<Result<PhoneView, PairError>>;
}
type OpenErrorForLink = "link_unknown" | "link_expired" | "link_exhausted" | "link_revoked" | "link_binding_failed";
type Result<T, E extends ErrorCode | "mint_limit" | "file_not_found"> =
  { ok: true; value: T } | { ok: false; error: E };

/** One instance. Routes typed codes; counts misses exactly (ADR 0002). */
export interface CodeDirectory {
  put(code: string, screenRef: string, expiresAt: number): Promise<"ok" | "collision">;
  lookup(code: string, ipHash: string, now: number):
    Promise<{ ok: true; screenRef: string } | { ok: false; error: "code_unknown" | "rate_limited" }>;
  remove(code: string): Promise<void>;
}
```

### 2.5 Codes (`public/js/shared/codes.js`, pure)
```js
// 30 symbols: no 0 O 1 I L U. 6 symbols = 30^6, about 7.3e8 (29.4 bits). CODE_LENGTH may rise to 7.
export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** @param {string} raw @returns {string | null} upper-cased, spaces and dashes removed, O->0 is not mapped */
export function normalize(raw) {
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  return /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6,7}$/.test(s) ? s : null;
}
/** @param {string} code @returns {string} "K7M Q9X" */
export function format(code) { return `${code.slice(0, 3)} ${code.slice(3)}`; }
```
Codes and match codes are drawn with `crypto.getRandomValues` and rejection sampling. Never use `% 30` on a byte: that is biased.

## 3. `FileSource` (`src/worker/seams/file-source/index.ts`)
```ts
import type { FileEntry, FileType, Mode, SourceError } from "../../../shared/protocol.ts";

export interface SourceContext {
  mode: Mode;
  userId: string | null;
  /** Graph only: returns a fresh access token from the vault, refreshing with compare-and-swap. */
  accessToken(): Promise<{ ok: true; token: string } | { ok: false; error: SourceError }>;
}

export interface Resolved {
  name: string;
  type: FileType;
  size: number | null;
  /** Pre-authenticated URL, host already checked against GRAPH_DOWNLOAD_HOSTS. Null when only streaming is possible. */
  url: string | null;
  /** Streams the bytes. Always available. */
  body(): Promise<{ ok: true; stream: ReadableStream<Uint8Array>; length: number | null } | { ok: false; error: SourceError }>;
}

export interface FileSource {
  readonly kind: "mock" | "graph";
  /** At most `limit` decks, newest edit first. Never .pptm or macro-enabled types. */
  listRecent(ctx: SourceContext, limit: number): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  /** Called at fetch time (the /f/ request), never at approve time: download URLs expire in minutes. */
  resolve(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  /** A PDF rendition, for the last fallback. Graph converts it; mock serves a fixture. */
  resolvePdf(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
}

/** Demo and local runs: fixtures from test/fixtures/decks, imported into the Worker bundle as data modules. Default. */
export declare class MockFileSource implements FileSource {
  readonly kind: "mock";
  constructor(fixtures: { id: string; name: string; type: FileType; path: string; pdfPath: string | null }[]);
  listRecent(ctx: SourceContext, limit: number): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  resolve(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  resolvePdf(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
}

/** Off until the Entra app exists (FILE_SOURCE=graph). Maps Graph 401 to auth_required, 403 with
 *  consent errors to admin_consent_required, 404 to file_not_found, 429 and 503 to source_throttled. */
export declare class GraphFileSource implements FileSource {
  readonly kind: "graph";
  constructor(opts: { fetch: typeof fetch; downloadHosts: string[]; now: () => number });
  listRecent(ctx: SourceContext, limit: number): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  resolve(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  resolvePdf(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
}
```
Open items for `GraphFileSource`: which Graph call lists recent decks for both work and personal accounts (folder children sorted by edit time, or search), and whether `Files.Read.Selected` can serve this flow (unverified). Both need the Entra app.

## 4. `OpenPath` (`src/worker/seams/open-path/index.ts`)
```ts
import type { LinkSet, OpenError, OpenMode } from "../../../shared/protocol.ts";
import type { FileRef } from "../../machine.ts";
import type { FileSource, SourceContext } from "../file-source/index.ts";

export interface MintedLink {
  token: string;        // screenRef (22) + secret (32), base64url; only its SHA-256 is stored
  tokenHash: string;
  purpose: OpenMode;
  url: string;          // https://<host>/f/<token>/<safe-name>.<ext>, at most 200 characters
}

export interface OpenPath {
  readonly mode: "redirect" | "stream";
  /** Builds the link set the screen gets. protocol = "ms-powerpoint:ofv|u|" + url (pptx only). */
  mint(screenRef: string, file: FileRef, purpose: OpenMode, origin: string): Promise<MintedLink>;
  links(protocol: MintedLink | null, download: MintedLink, pdf: MintedLink | null): LinkSet;
  /** Serves an accepted /f/ request. GET and HEAD only; the caller already ran useLink. */
  serve(req: Request, file: FileRef, ctx: SourceContext, source: FileSource | GuestReader): Promise<Response>;
}
export interface GuestReader { read(r2Key: string): Promise<ReadableStream<Uint8Array> | null>; }

/** 302 to the resolved Graph URL (default until T3). Guest files always stream. */
export declare class RedirectOpenPath implements OpenPath {
  readonly mode: "redirect";
  mint(screenRef: string, file: FileRef, purpose: OpenMode, origin: string): Promise<MintedLink>;
  links(protocol: MintedLink | null, download: MintedLink, pdf: MintedLink | null): LinkSet;
  serve(req: Request, file: FileRef, ctx: SourceContext, source: FileSource | GuestReader): Promise<Response>;
}
/** Streams bytes through the Worker. */
export declare class StreamOpenPath implements OpenPath {
  readonly mode: "stream";
  mint(screenRef: string, file: FileRef, purpose: OpenMode, origin: string): Promise<MintedLink>;
  links(protocol: MintedLink | null, download: MintedLink, pdf: MintedLink | null): LinkSet;
  serve(req: Request, file: FileRef, ctx: SourceContext, source: FileSource | GuestReader): Promise<Response>;
}

/** HTTP status the /f/ route returns per error. 410 tells Office the file is gone for good. */
export const OPEN_STATUS: Record<OpenError, number> = {
  link_unknown: 404, link_expired: 410, link_exhausted: 410, link_revoked: 410,
  link_binding_failed: 403, upstream_failed: 502, launch_timeout: 504, pdf_unavailable: 404, mint_limit: 429,
};
```

Screen side (`public/js/screen.js`, JSDoc):
```ts
/** Launch ladder: protocol, then download after 5 s with no fetch, then PDF if Download fails or is refused. */
export interface ScreenLauncher {
  launch(links: LinkSet): void;            // location.assign(links.protocol); reports "launched"
  download(): Promise<void>;               // POST /api/screen/link {purpose:"download"}, then <a download>
  showPdf(): Promise<void>;                // POST /api/screen/link {purpose:"pdf"}, window.open, keeps the ref
}
```

## 5. `GuestDrop` (`src/worker/seams/guest-drop/index.ts`)
```ts
import type { DropError, FileType } from "../../../shared/protocol.ts";

export type GuestPolicy = "off" | "pass" | "open";

export interface Upload {
  sessionKey: string;          // screenRef + pairing, used to build the R2 key
  declaredName: string;        // from X-Bloop-Name, percent-decoded, then sanitized
  declaredType: string;        // Content-Type
  length: number;              // Content-Length, required
  body: ReadableStream<Uint8Array>;
}
export interface GuestFile { r2Key: string; name: string; type: FileType; bytes: number; sha256: string; }

export interface GuestDrop {
  policy(roomPolicy: GuestPolicy | null, mode: "live" | "demo"): GuestPolicy;
  /** Streams to storage with a byte counter, then validates by range reads. Deletes on any failure. */
  accept(u: Upload, maxBytes: number): Promise<{ ok: true; file: GuestFile } | { ok: false; error: DropError }>;
  read(r2Key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(r2Key: string): Promise<void>;          // idempotent
  /** Hourly backstop: deletes objects older than the given age. Returns the count. */
  sweep(olderThanMs: number): Promise<number>;
}

/** Pure checks over byte ranges (src/worker/seams/guest-drop/validate.ts). */
export interface RangeReader { size: number; read(offset: number, length: number): Promise<Uint8Array>; }
export type Validate = (r: RangeReader, declared: FileType) => Promise<{ ok: true; type: FileType } | { ok: false; error: DropError }>;

export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxCentralDirectoryBytes: 2 * 1024 * 1024,
  maxTotalUncompressed: 1024 * 1024 * 1024,
  maxEntryRatio: 200,
  requiredParts: ["[Content_Types].xml", "ppt/presentation.xml"],
  refusedParts: [/^ppt\/vbaProject\.bin$/i, /^ppt\/activeX\//i, /\.bin$/i],
  refusedContentTypes: [/macroEnabled/i, /vbaProject/i],
  zip64: "refuse",
} as const;
```
Validation rules: a `.pptx` starts with `PK\x03\x04`, has no `%PDF` in its first 1 KB, has an EOCD record whose central directory is inside the file and within the limits, and passes the part rules. A `.pdf` starts with `%PDF-`, has `%%EOF` in its last 1 KB, and has no ZIP EOCD signature in its last 64 KB. The extension must match the detected type. `Content-Type` on the way out comes from the detected type, never from the upload.

## 6. `Residue` (`src/worker/seams/residue.ts` and `public/js/residue.js`)
```ts
import type { FileRef } from "../machine.ts";

/** Server side, run by the Screen object on end, cancel, timeout and close. Each step is idempotent. */
export interface ServerResidue {
  purge(input: { sessionId: string | null; file: FileRef | null }): Promise<PurgeReport>;
}
export interface PurgeReport {
  linksRevoked: number;        // link rows deleted from DO storage
  pairingCleared: boolean;     // pairing secret hash, listed ids, pass hash
  guestObjectDeleted: boolean | null;   // null when there was no guest file
  accessTokenDropped: boolean; // in-memory access token for this session
}

/** Screen side. Runs on "ended", on "closed", and on pagehide. */
export interface ScreenResidue {
  clear(): void;               // sessionStorage bloop.*, in-memory links, revoke object URLs,
                               // close the PDF window if this page opened it, history.replaceState("/s")
  /** What a web page cannot clean. Shown on /it, measured per room by the T20 audit. */
  readonly beyondReach: readonly ("downloads_folder" | "office_recent_list" | "office_cache"
    | "jump_lists" | "browser_download_history" | "temp_internet_files")[];
}
```
`POST /api/screen/end` also answers with `Clear-Site-Data: "storage"`. That clears the origin's storage in the lectern browser even when the page script has been tampered with. It has to be verified on the lectern browser (T20).

## 7. `AuditLog` and `Metrics` (`src/worker/audit.ts`, `src/worker/metrics.ts`)
```ts
import type { Actor, ErrorCode, Kind, Mode } from "../shared/protocol.ts";
import type { AuditType, MetricName } from "./machine.ts";

export interface AuditEvent {
  sessionId: string; at: number; actor: Actor;
  type: AuditType | "grant.created" | "grant.deleted" | "user.erased" | "export.run" | "pass.created";
  /** Allowed keys only. Never tokens, codes, URLs, IPs or Graph ids. */
  detail: { fileName?: string; source?: "mock" | "graph" | "guest"; purpose?: string;
            cause?: ErrorCode; reason?: string; bytes?: number; ipMatch?: boolean };
}
export interface AuditRow extends AuditEvent { id: number; roomName: string | null; userEmail: string | null; mode: Mode; kind: Kind; }

export interface AuditLog {
  record(e: AuditEvent): Promise<void>;
  forUser(userId: string, limit: number, before?: number): Promise<AuditRow[]>;
  /** IT export. CSV cells starting with = + - @ tab or CR get a leading apostrophe. */
  export(q: { orgId: string | null; from: number; to: number; format: "csv" | "json" }): Promise<ReadableStream<Uint8Array>>;
  purge(now: number, retention: { liveDays: number; demoDays: number }): Promise<number>;
  /** Erasure: keeps session, room and time; drops user id and file name. */
  anonymizeUser(userId: string): Promise<number>;
}

export type FailureCause = ErrorCode | "screen_offline" | "phone_offline";
export interface MetricEvent { at: number; mode: Mode; kind: Kind; roomId: string | null; name: MetricName; ms?: number; cause?: FailureCause; }

export interface Metrics {
  record(e: MetricEvent): Promise<void>;
  /** Week-3 return: one row per pseudonymous user per ISO week. */
  activeWeek(userId: string, now: number): Promise<void>;
  rollup(day: string): Promise<void>;     // metric_event to metric_daily
  purge(now: number, days: number): Promise<number>;
}
```

## 8. Error codes, HTTP status and user-facing state (`public/js/shared/errors.js`)
```js
/** @import {ErrorCode, PhoneStateKey, ScreenStateKey} from "../../../src/shared/protocol.ts" */
/** @type {Record<ErrorCode, {status: number, phone: PhoneStateKey | null, screen: ScreenStateKey | null}>} */
export const ERRORS = {
  // pairing
  code_malformed:   { status: 400, phone: "typed_wrong",  screen: null },
  code_unknown:     { status: 404, phone: "typed_wrong",  screen: null },   // a QR scan shows "expired" instead
  code_expired:     { status: 410, phone: "expired",      screen: null },
  code_taken:       { status: 409, phone: "taken",        screen: null },
  rate_limited:     { status: 429, phone: "rate_limited", screen: null },
  pairing_invalid:  { status: 401, phone: "expired",      screen: null },
  screen_gone:      { status: 410, phone: "expired",      screen: "service_down" },
  wrong_state:      { status: 409, phone: "taken",        screen: null },
  session_ended:    { status: 410, phone: "ended",        screen: "ended" },
  // file source
  auth_required:          { status: 401, phone: "first_use",   screen: null },
  admin_consent_required: { status: 403, phone: "needs_admin", screen: null },
  consent_declined:       { status: 403, phone: "canceled",    screen: null },
  no_files:               { status: 200, phone: "empty",       screen: null },
  file_not_found:         { status: 404, phone: "error",       screen: "error" },
  file_type_refused:      { status: 415, phone: "error",       screen: null },
  source_throttled:       { status: 503, phone: "error",       screen: "error" },
  source_unavailable:     { status: 502, phone: "error",       screen: "error" },
  // open path (the /f/ client is PowerPoint; these states reach people through the Screen object)
  link_unknown:        { status: 404, phone: null,            screen: "error" },
  link_expired:        { status: 410, phone: null,            screen: "error" },
  link_exhausted:      { status: 410, phone: null,            screen: "error" },
  link_revoked:        { status: 410, phone: "ended",         screen: "ended" },
  link_binding_failed: { status: 403, phone: null,            screen: "error" },
  upstream_failed:     { status: 502, phone: "error",         screen: "error" },
  launch_timeout:      { status: 504, phone: "open_fallback", screen: "open_fallback" },
  pdf_unavailable:     { status: 404, phone: "error",         screen: "error" },
  mint_limit:          { status: 429, phone: null,            screen: "error" },
  // guest drop
  drop_disabled:    { status: 403, phone: "error",             screen: null },
  pass_required:    { status: 403, phone: "guest_pass_needed", screen: null },
  pass_invalid:     { status: 403, phone: "guest_pass_needed", screen: null },
  length_required:  { status: 411, phone: "guest_refused",     screen: null },
  too_large:        { status: 413, phone: "guest_refused",     screen: null },
  bad_type:         { status: 415, phone: "guest_refused",     screen: null },
  bad_structure:    { status: 422, phone: "guest_refused",     screen: null },
  macro_content:    { status: 422, phone: "guest_refused",     screen: null },
  storage_full:     { status: 507, phone: "busy",              screen: null },
  upload_aborted:   { status: 400, phone: "error",             screen: null },
  already_uploaded: { status: 409, phone: "taken",             screen: null },
  // http
  bad_request:            { status: 400, phone: "error", screen: "error" },
  unsupported_media_type: { status: 415, phone: "error", screen: "error" },
  forbidden_origin:       { status: 403, phone: "error", screen: "error" },
  unauthorized:           { status: 401, phone: "expired", screen: "error" },
  not_found:              { status: 404, phone: "error", screen: "error" },
  method_not_allowed:     { status: 405, phone: "error", screen: "error" },
  internal:               { status: 500, phone: "error", screen: "error" },
  // client only, never sent by the server
  offline:      { status: 0, phone: "offline",      screen: "offline" },
  service_down: { status: 0, phone: "error",        screen: "service_down" },
};
```

## 9. Strings the design still needs
The shared state strings have no slot for these. Wording is a design.md decision, so these are proposals only:
- `rate_limited` (phone): "Too many tries." / "Wait a minute, then scan the code again."
- `guest_pass_needed` (phone): "Ask your host for a guest link." / "Open it on this phone, then scan the code again."
- `busy` (phone): "bloop can't take files right now." / "Try again in a few minutes, or sign in to the PC as usual."
- Screen `guest_open` (offered state): heading "{file name}", line "Sent by a guest. Open it here when you're ready.", control "Open". The click is the proof of presence at the lectern, and no guest file opens without it.
- Screen "Start Over" (decided, OD-6; text button in the scanned, choosing and offered states): ends a claim nobody at the lectern recognizes (PAIR-02).
- `guest_refused` fills `{N}` from `GUEST_MAX_BYTES` (default 50 MB; demo 10 MB).
