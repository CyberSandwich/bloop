# bloop interfaces

The contracts for the five seams (pairing, file source, open path, guest drop, residue), plus audit and metrics. Each block names the file it belongs in. Types are TypeScript. Browser code imports the `src/shared/protocol.ts` types through JSDoc (`/** @import {ScreenView} from "../../src/shared/protocol.ts" */`, from `public/js/`). Runtime code shared by the browser and the Worker lives in `public/js/shared/` as plain JSDoc-typed ES modules, and the Worker imports it by relative path. No type from Cloudflare, Graph or R2 crosses a seam: adapters translate at the edge, so the Node exit path (ADR 0001) rewrites adapters only.

## 1. Shared protocol (`src/shared/protocol.ts`, contracts, never served; type-only except `OPEN_MODES`, the one list the Worker's schemas build from)
```ts
export type Mode = "live" | "demo";
export type Kind = "owner" | "guest";
export type FileType = "pptx" | "pdf" | "jpg" | "png" | "mp4" | "mov";
export const OPEN_MODES = ["protocol", "download", "pdf", "view"] as const;   // the launched frame and POST /api/screen/link both use it
export type OpenMode = (typeof OPEN_MODES)[number];   // view: an image shown in the screen page
export type EndReason = "phone" | "screen" | "auto" | "canceled" | "claim_timeout" | "error";
export type Actor = "screen" | "phone" | "system" | "host" | "it";

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/** Session states owned by the Screen object (section 2). */
export type SessionState =
  | "waiting" | "claimed" | "choosing" | "uploading" | "offered"
  | "approved" | "opening" | "open" | "ended" | "closed";

export interface RoomView { name: string | null; registered: boolean; }   // name: the registered room's, "Demo Room" for a demo, null for an unregistered live room (the phone titles it with the match number)
export interface CodeView { code: string; expiresAt: number; qrUrl: string; }

/** What a page may show of an approved item: no source id or URL (SRC-01). */
export interface FileItem { kind: "file"; id: string; name: string; type: FileType; size: number | null; }   // id: server-assigned at approval ("i1", "i2", ... in list order), opaque, unique in the session, never an index or derived from the source; size: bytes, when the source gave one
/** https on an allowed host only (LINK-01); the screen shows a card with the host, opened by a click, never a frame. */
export interface LinkItem { kind: "link"; id: string; url: string; title: string; }   // id: as on FileItem
export type Item = FileItem | LinkItem;

/** What the screen shows: `shown` in both views. */
export type Sound = "on" | "off" | "blocked";   // blocked: the screen's browser refused unmuted play (no tap on the page yet), so it plays muted with Tap for Sound (VID-05)
export interface Shown { item: string; page: number; present: boolean; play?: boolean; sound?: Sound; }   // item: a FILE item's id (the screen's own report may also name a link, at page 1); page: 1-based, within the item's pages; play and sound: a video's state, absent meaning playing with sound, so stored data from before them stays valid; either sender may send `blocked`, since a phone's command repeats the view it was built on
/** The body of POST /api/control and POST /api/screen/shown. Absolute, so a replay changes nothing; a seq not above the sender's last applied one changes nothing, and one more than 24 h ahead of the server's clock is `bad_request`. */
export interface ShownCommand extends Shown { seq: number; }   // the sender's clock in ms, at least one above its last, and above the `seq` of its latest view (the server's last for that sender), so a clock that fell behind across a reload still sends in order (PAIR-13)
/** The body of POST /api/session/length: the session ends `seconds` from now, never past approval plus the mode's cap. */
export interface LengthRequest { seconds: number; }   // whole seconds, MIN_LENGTH_SECONDS (public/js/shared/length.js) to SESSION_MAX_MINUTES x 60

export interface ScreenView {
  state: SessionState;
  mode: Mode;
  kind: Kind | null;
  room: RoomView;
  code: CodeView | null;       // only in "waiting" and "ended"
  match: string | null;        // 2 digits, from "claimed" to "open"
  items: Item[];               // from "offered" (guest) or "approved", else []; files by name, then links by title; a link or mint names an item by its index here, the remote by its `id`
  shown: Shown | null;         // set by the phone's remote or the screen's own tap (demo only); null until then and outside a session
  openMode: OpenMode | null;   // an original PDF shown as a PDF is the `pdf_file` state, not `pdf_fallback`
  endsAt: number | null;
  endReason: EndReason | null;
  seq: number;                 // the last `control` seq applied from this screen; 0 before any
  v: number;                   // applied changes so far (`Machine.v`): of two views of one session the larger `v` is the newer, equal ones are one state; a client adopts only a larger one
  now: number;
}

export interface PhoneView {
  state: SessionState;
  mode: Mode;
  kind: Kind;
  room: RoomView;
  match: string;
  items: Item[];               // as in ScreenView
  shown: Shown | null;         // as in ScreenView
  openMode: OpenMode | null;
  endsAt: number | null;       // with `now`, the phone's countdown to the session's own end
  endReason: EndReason | null;
  dropMaxBytes: number;        // the largest guest file this screen takes (GUEST_MAX_BYTES, or the demo cap)
  maxMinutes: number;          // the mode's cap (SESSION_MAX_MINUTES, or DEMO_MAX_MINUTES): the longest length the phone offers
  seq: number;                 // the last `control` seq applied from this phone; 0 before any
  v: number;                   // as in ScreenView
  now: number;
}

// One mint fills one field; the others stay null.
export interface LinkSet {
  protocol: string | null;   // ms-powerpoint:ofv|u|<url>, pptx only
  download: string | null;
  pdf: string | null;        // a PDF file's own view, or a deck's PDF rendition
  view: string | null;       // an image, inline
}

// WebSocket frames, all {v: 1, t: ...}, at most 4 KB. The upgrade URL carries the non-secret screenRef
// (`/api/screen/ws?ref=<screenRef>`, `/api/pair/ws?ref=<screenRef>`): the first frame is the credential.
// The exact text {"v":1,"t":"ping"} is answered with {"v":1,"t":"pong"} by the runtime without waking the object.
export type ScreenMsgIn =
  | { v: 1; t: "hello"; sid: string }
  | { v: 1; t: "code.next" }
  | { v: 1; t: "open.click" }      // the Open button on a guest offer
  | { v: 1; t: "launched"; mode: OpenMode }
  | { v: 1; t: "ping" };
export type ScreenMsgOut =
  | { v: 1; t: "state"; view: ScreenView }
  | { v: 1; t: "open"; item: number; links: LinkSet; now: number }   // item: index into ScreenView.items
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };
export type PhoneMsgIn = { v: 1; t: "hello"; pid: string } | { v: 1; t: "ping" };
export type PhoneMsgOut =
  | { v: 1; t: "state"; view: PhoneView }
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };

export interface ClaimRequest { code: string; kind?: Kind; }   // kind defaults to "owner"; "guest" asks for the drop path
export interface ClaimResponse {
  pid: string; room: RoomView; match: string; mode: Mode; kind: Kind; needsAuth: boolean; dropMaxBytes: number;
}
/** A row of the phone's list: `GET /api/files` answers `{items: Entry[]}`, files first, then links. */
export interface FileEntry extends Omit<FileItem, "id"> { id: string; modifiedAt: number; }   // id: the source's entry id, not an item id; opaque to the phone; never a Graph URL
export interface LinkEntry extends Omit<LinkItem, "id"> { id: string; }
export type Entry = FileEntry | LinkEntry;
export interface ApproveRequest { ids: string[]; }                     // POST /api/approve: 1 to MAX_ITEMS (12) distinct entry ids
export interface LinkRequest { purpose: OpenMode; item?: number; }    // POST /api/screen/link: item defaults to the launched one
export interface LinkResponse { item: number; links: LinkSet; }

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
  | "drop_disabled" | "pass_required" | "length_required" | "too_large"
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
  | "pdf_file" | "ended" | "canceled" | "expired" | "taken" | "offline" | "error" | "guest_add"
  | "guest_confirm" | "guest_sending" | "guest_refused" | "guest_sent" | "typed_wrong" | "framed"
  | "rate_limited" | "guest_pass_needed" | "guest_off" | "busy";          // last five: strings added to design.md section 7 (section 9)
export type ScreenStateKey =
  | "waiting" | "scanned" | "choosing" | "approved" | "opening" | "open" | "open_fallback"
  | "pdf_fallback" | "pdf_file" | "guest_open" | "ended" | "offline" | "service_down" | "error" | "phone_width"
  | "rate_limited"   // a refused screen create (DEMO-02): its own design.md row, retried with backoff
  | "demo_open";     // a demo screen from approved to open: the viewer, whatever the open mode (DEMO-01)
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
| offered | `offerAt` = offeredAt + `CLAIM_TIMEOUT_SECONDS` | `waiting` (`claim_timeout`), object deleted (the object has no file ref while still uploading, so `purge` carries `file: null` and the guest-drop module deletes by session key) |
| approved, opening, open | `endsAt` = approvedAt + `SESSION_DEFAULT_MINUTES`, then wherever the phone's `length` sets it, never past approvedAt + the mode's cap (`SESSION_MAX_MINUTES`; demo `DEMO_MAX_MINUTES`) | `ended` (`auto`) |
| ended | `closeAt` as in waiting | `closed` |

- Code expiry is not a timer. A code is valid while `now < expiresAt`, which is `issuedAt + CODE_TTL_SECONDS + CODE_GRACE_SECONDS`. The screen asks for the next code every `CODE_TTL_SECONDS`. The previous code stays claimable until the earlier of its own `expiresAt` and `CODE_GRACE_SECONDS` after its successor was issued. The code a screen shows (`CodeView.expiresAt`) is `issuedAt + CODE_TTL_SECONDS`.
- A drop back to `waiting` (cancel, Start Over, any timeout) wipes both codes, and the Screen object issues a fresh one at once. The reason (`endReason`) stays on the view through rotation until a claim, so the screen can say why. After `ended`, the phone can still read its final state: the pairing keeps `secretHash`, `kind`, `match` and `sessionId` (listed ids, pass hash and user id are dropped) until the next `code.next`.
- `socket` events carry the open WebSocket count. `closeAt` is armed whenever the count is 0 in `waiting` or `ended`, and every authenticated screen poll re-arms it, so a polling screen stays open.

### 2.2 Transition table
| from | event | guard | to | effects |
|---|---|---|---|---|
| waiting, ended | `code.next` | at most 6 per min (`rate_limited`); ended for at least 3 s | waiting | issue code, Directory put (the previous-but-one code is removed), push screen `state` |
| waiting | `claim(code)` | code is current or previous, unconsumed, unexpired. In any other state the answer is `code_taken` for a code the screen still holds and `code_expired` otherwise | claimed | consume code (the Directory keeps it, so a replay answers `code_taken`); session id, pairing secret, match code; push both; audit `claimed` |
| waiting | `claim(code, pass)` | as above, plus a pass valid for this room | claimed (kind guest) | as above; mark the pass used |
| claimed | `listed(ids)` | owner kind | choosing | store ids; push both |
| claimed, choosing | `approve(items)` | 1 to `MAX_ITEMS` items with distinct refs, else `bad_request`; live: exactly one file, else `bad_request` (a live screen has no viewer to reach a second item or a link); owner kind; every ref in stored ids (live) or entries the Worker resolved (demo), else `file_not_found` | approved | items in `orderItems` order, `endsAt`, mint the protocol link for the first file (none for links only); push screen `open`; audit `approved` |
| claimed, choosing | `upload.start` | policy allows it (checked by `beginDrop`), no file yet; a `choosing` pairing must be an owner's | uploading | set `uploadAt`; an owner pairing becomes a guest (list and account dropped), so a phone can claim first and choose to send a file later |
| uploading | `upload.done(file)` | validated | offered | store the R2 ref and `offerAt`; push screen `guest_open` (file name, Open); audit `guest.uploaded` |
| offered | `open.click` | from the screen socket (a repeat in approved, opening or open returns the current view) | approved | as approve: `endsAt`, mint link; push screen `open`; audit `approved` (actor screen) |
| uploading | `upload.failed(e)` | | claimed | delete object; push both `state`; audit `guest.refused` with cause `e` (the drop route answers the phone with `e`) |
| approved, opening, open | `control(from, seq, shown)` | from the phone (`POST /api/control`, pid) or the screen (`POST /api/screen/shown`, sid); demo only (a live session is `wrong_state`); `shown.item` names a FILE item by id, else `file_not_found` (PAIR-11, LINK-01), except that the screen's report may name a link's id (the card it shows, so the phone's mark leaves the file; never a command); `shown.page` is within the item's pages (a demo owner's deck or PDF has 2, anything else and a link 1), else `bad_request`; `shown.play` and `shown.sound` set a video's play state (VID-05); any other state is `wrong_state` | (same) | a `seq` more than 24 h ahead of the event's clock is `bad_request` (one far ahead would refuse every later command from its sender); a `seq` not above `session.seq[from]` changes nothing (a replay, or a late older command); else store the seq, and store `session.shown` and push both unless it is the same `shown` (an absent `play` equals true and an absent `sound` equals `on`), which pushes nothing. Between senders the last applied wins (PAIR-13) |
| approved, opening, open | `length(minutes, maxMinutes)` | from the phone (`POST /api/session/length`, pid), both modes; the route takes whole `minutes` from 5 to `SESSION_MAX_MINUTES`, and the Screen object passes the mode's cap; any other state is `wrong_state` | (same) | `endsAt` = min(now + minutes, approvedAt + maxMinutes), so no run of changes outlives the cap; audit `session.length` (actor `phone`, detail `endsAt`), push both and the alarm moves to it; the audit row is written only when the end is a minute or more from the end last audited (`auditedEndsAt`, set then; until then the approved end), and the same `endsAt` again pushes nothing. Absolute, never a delta: a replay sets about the same end. At or past `endsAt` (an alarm running late) it ends the session as `timer` would (`ended`, `auto`), and the Screen object answers `session_ended` (SESS-01) |
| approved | `launched(mode)` | from the screen | opening | record mode; metric |
| approved, opening | `fetched(link)` | first fetch of any link | open | `first_open_at`; metric `scan_to_open_ms`; push both |
| opening, open | `fallback(mode, item)` | `item` (default: the first file) names a file, else `file_not_found` (PAIR-11); mints left | (same) | mint a link for `mode` and that item; when it is the launched item, set the open mode to what the link serves for the type (`effectivePurpose`: a deck's view is its PDF); metric `fallback`; push `open` to the screen and `state` to both |
| approved | `fallback(protocol, item)` | as above | (same) | the screen lost its link, or shows another item: mint its protocol (or view) link, no mode change, no metric |
| claimed, choosing, uploading, offered | `cancel` | from the phone | waiting | end reason `canceled`; audit; delete any object; both codes wiped, a fresh one issued; phone sockets get `error pairing_invalid` and close |
| claimed, choosing, uploading, offered | `restart` | from the screen ("Start Over") | waiting | end reason `canceled`, actor screen; audit; delete any object; as cancel |
| approved, opening, open | `end(by)` | | ended | revoke links; residue purge; audit `ended`; metric; push both |
| claimed to offered | `end(by)` | | ended | as above, no session row change beyond `ended_at` |
| any timer state | `timer(now)` | deadline passed | per 2.1 | per 2.1 |
| ended, waiting | `timer(now)` | `closeAt` passed, no socket | closed | `deleteAll()` |
| waiting | `end(screen)` | from the screen only (a phone or system end here is `wrong_state`) | closed | both codes removed, `deleteAll()` (which releases a demo slot); no audit, as there was no session. The answer is the closed view, and the sid then answers `screen_gone`. A `claimed` screen still goes to `ended`, so its phone reads why |
| closed | any | | closed | every call returns `screen_gone` |

An event the table does not list for a state returns `wrong_state` and changes nothing; approve in `ended` returns `session_ended`. Approve (the same set of items, in any order), open.click, fetched, control and end are idempotent: a repeat in the target state returns the current view. Cancel is not: it drops the pairing, so a repeat fails with `pairing_invalid` before it reaches the machine.

### 2.3 The pure machine (`src/worker/machine.ts`)
```ts
import type { EndReason, ErrorCode, FileType, Kind, Mode, OpenMode, SessionState } from "../shared/protocol.ts";

export interface Code { value: string; issuedAt: number; expiresAt: number; consumed: boolean; }
export interface FileRef { source: "mock" | "graph" | "guest"; ref: string; name: string; type: FileType; size?: number; }

// src/worker/items.ts: the item types, the order and the link rule, shared by the machine, the routes and the tests.
export interface LinkRef { kind: "link"; id: string; ref: string; url: string; title: string; }
export type FileItemRef = FileRef & { kind: "file"; id: string };
export type ItemRef = FileItemRef | LinkRef;
export type ItemDraft = Omit<FileItemRef, "id"> | Omit<LinkRef, "id">;   // an item before approval gives it an id
export const MAX_ITEMS = 12;
export const LINK_HOSTS: readonly string[];          // ["www.vevox.com"]
export declare function allowedLink(url: string): string | null;   // URL-parsed: https, an allowed host, no credentials, no explicit non-default port, at most 2048 characters; answers url.href, the only form an item stores
export declare function orderItems<T extends ItemDraft>(items: readonly T[]): T[];   // files by name, then links by title
export declare function withIds(items: readonly (ItemDraft | ItemRef)[]): ItemRef[];   // "i1", "i2", ... by place in the ordered list, written at approval (or upload.done); a list whose items all hold ids keeps them (a guest's file at open.click), one missing any is numbered whole
export declare const shownSchema: z.ZodType<Shown>;   // the one shape check for `shown` (strict; `play` and `sound` optional): the remote's body extends it with `seq`, and schema step 6 repairs stored data with it (step 7 starts a missing or malformed `Machine.v` at 0)
export declare function shownFault(items: readonly ItemRef[], shown: Shown, view: { mode: Mode; kind: Kind | null }): "file_not_found" | "bad_request" | null;   // not a FILE id in the list, or a page outside it
export declare function fileById(items: readonly ItemRef[], id: string): FileItemRef | null;   // null for a link or an unknown id
export declare function pageCount(file: FileItemRef, view: { mode: Mode; kind: Kind | null }): number;   // the demo owner's deck or PDF: the pre-rendered pages; else 1
export declare function launchIndex(items: readonly ItemRef[]): number;    // the first file, -1 for links only
export declare function fileAt(items: readonly ItemRef[], index: number): FileItemRef | null;
export declare function itemView(item: ItemRef): Item;

export interface Machine {
  state: SessionState;
  v: number;                         // counts every applied change (a changed machine, never a no-op); every view carries it; schema step 7
  mode: Mode;
  codes: { current: Code | null; previous: Code | null };
  codeRequests: number[];            // issue times in the last minute
  pairing: {
    sessionId: string;               // the D1 session id and the audit key; one per claim
    kind: Kind; match: string; claimedAt: number; secretHash: string;
    listed: string[]; userId: string | null; passHash: string | null;
  } | null;
  session: {                         // the approved items, ordered; approvedAt and endsAt are null while "offered" (one guest file)
    items: ItemRef[]; approvedAt: number | null; endsAt: number | null;
    auditedEndsAt?: number;          // the end last audited, or the approved end once a change went unaudited; absent: never changed
    openMode: OpenMode | null; firstOpenAt: number | null; minted: number[];   // links minted per item index, the first included; capped at 1 + LINK_MINTS_PER_ITEM
    shown: Shown | null;   // set by `control`
    seq: { phone: number; screen: number };   // the last `control` seq applied per sender; 0 in a new session
  } | null;
  uploadAt: number | null;
  offerAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  closeAt: number | null;            // only in waiting and ended, only while no socket is open
  sockets: number;                   // open WebSocket count, set by the `socket` event
}

export type Event =
  | { e: "code.next"; now: number; value: string }                      // value drawn by the caller
  | { e: "claim"; now: number; code: string; sessionId: string; secretHash: string; match: string;
      kind: Kind; userId: string | null; passHash: string | null }
  | { e: "listed"; now: number; ids: string[] }
  | { e: "approve"; now: number; items: ItemDraft[]; maxMinutes: number; userId?: string | null }
  | { e: "upload.start"; now: number; timeoutSeconds: number }
  | { e: "upload.done"; now: number; file: FileRef }
  | { e: "upload.failed"; now: number; error: ErrorCode }
  | { e: "open.click"; now: number; maxMinutes: number }                 // the Open button on a guest offer
  | { e: "launched"; now: number; mode: OpenMode }
  | { e: "fetched"; now: number }
  | { e: "control"; now: number; from: "phone" | "screen"; seq: number; shown: Shown }   // the phone's remote, or the screen reporting its own tap
  | { e: "fallback"; now: number; mode: OpenMode; item: number | null; maxMints: number }   // null: the first file
  | { e: "cancel"; now: number }
  | { e: "restart"; now: number }
  | { e: "end"; now: number; by: "phone" | "screen" | "system" }
  | { e: "socket"; now: number; open: number }                          // open socket count
  | { e: "timer"; now: number };

export type Effect =
  | { fx: "directory.put"; code: string; expiresAt: number }
  | { fx: "directory.remove"; code: string }                           // a code retired without a claim
  | { fx: "push"; to: "screen" | "phone" | "both" }
  | { fx: "mint"; purpose: OpenMode; item: number }                    // approve mints "protocol" for the first file
  | { fx: "revokeLinks" }
  | { fx: "purge"; file: FileRef | null }                              // Residue.server: a guest object only (null while uploading); an owner session purges nothing
  | { fx: "audit"; type: AuditType; actor: "screen" | "phone" | "system"; cause?: ErrorCode }
  | { fx: "metric"; name: MetricName; ms?: number; cause?: ErrorCode }
  | { fx: "deleteAll" };

export type AuditType =
  | "claimed" | "approved" | "link.minted" | "link.fetched" | "link.refused" | "canceled"
  | "ended" | "guest.uploaded" | "guest.refused" | "guest.deleted" | "session.length";
export type MetricName =
  | "scan_to_open_ms" | "approve_to_open_ms" | "failure" | "fallback" | "session_minutes";

export type Step = { ok: true; next: Machine; effects: Effect[] } | { ok: false; error: ErrorCode };

/** Pure: no I/O, no clock, no randomness. The Screen object applies effects in order. */
export type Transition = (m: Machine, ev: Event, cfg: MachineConfig) => Step;

/** Earliest deadline for the single alarm, or null for none. */
export type NextDeadline = (m: Machine, cfg: MachineConfig) => number | null;

export interface MachineConfig {
  codeTtlSeconds: number; codeGraceSeconds: number; claimTimeoutSeconds: number;
  closeAfterSeconds: number; maxCodesPerMinute: number; endedMinSeconds: number;
}
```

### 2.4 `PairingStore` (`src/worker/seams/pairing.ts`), implemented by the Screen object
```ts
import type {
  ClaimResponse, CodeView, ErrorCode, Kind, Mode, PhoneView, RoomView, ScreenView, ShownCommand,
} from "../../shared/protocol.ts";
import type { ItemDraft } from "../items.ts";
import type { FileRef } from "../machine.ts";

/** Errors are PairError codes, plus file_not_found (approve), unauthorized (a bad sid) and internal. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };

export interface ScreenCreated { sid: string; room: RoomView; view: ScreenView; }
export interface PhoneInfo { kind: Kind; ipHash: string; userId: string | null; passHash: string | null; }

/**
 * One per screen. sid = screenRef + "." + screenSecret; pid = screenRef + "." + pairingSecret.
 * Methods take the full credential; the object compares the secret half's hash in constant time.
 * Over Workers RPC a function cannot be passed in, so approve takes the items the Worker already resolved
 * and the object checks their refs against the listed ids (live).
 */
export interface PairingStore {
  create(input: { screenRef: string; mode: Mode; roomId: string | null; roomName: string | null }): Promise<Result<ScreenCreated>>;
  nextCode(sid: string): Promise<Result<CodeView>>;
  claim(code: string, phone: PhoneInfo): Promise<Result<ClaimResponse>>;
  listed(pid: string, ids: string[]): Promise<Result<PhoneView>>;
  /** `userId`: the account the approving phone is signed in as now; the object keeps it for /f/ (null for demo and guest). */
  approve(pid: string, items: ItemDraft[], userId: string | null): Promise<Result<PhoneView>>;
  /** The phone's remote (POST /api/control): what the screen shows. Absolute, so a repeat is a no-op, and a seq not above the phone's last applied one changes nothing. Demo only: a live session is `wrong_state`. */
  control(pid: string, command: ShownCommand): Promise<Result<PhoneView>>;
  /** The screen reports its own tap (POST /api/screen/shown), so the phone's highlight stays true. Same rules as `control`, with its own seq. */
  reportShown(sid: string, command: ShownCommand): Promise<Result<ScreenView>>;
  /** The phone sets when the session ends (POST /api/session/length): `minutes` from now, never past approval plus the mode's cap. Both modes. One that arrives after the end ends the session and answers `session_ended`. */
  setLength(pid: string, seconds: number): Promise<Result<PhoneView>>;
  cancel(pid: string): Promise<Result<PhoneView>>;
  restart(sid: string): Promise<Result<ScreenView>>;
  endFromScreen(sid: string): Promise<Result<ScreenView>>;   // from waiting: closes the object (state "closed")
  endFromPhone(pid: string): Promise<Result<PhoneView>>;
  /** Polling fallback. A screen poll also rotates the code when it is due and re-arms closeAt. */
  screenView(sid: string): Promise<Result<ScreenView>>;
  phoneView(pid: string): Promise<Result<PhoneView>>;
  /**
   * A phone is about to upload (the guest drop). Applies the room's policy (`drop_disabled`, `pass_required`),
   * refuses a second file (`already_uploaded`) and a length over this screen's cap (`too_large`), then moves the
   * session to `uploading`; an owner claim becomes a guest. Answers the session id the object belongs to.
   */
  beginDrop(pid: string, length: number): Promise<Result<{ sessionId: string }>>;
  /** The object is stored and validated: `uploading` to `offered`. */
  dropDone(pid: string, file: FileRef): Promise<Result<PhoneView>>;
  /** The upload failed or was refused: `uploading` to `claimed`, the object purged, `guest.refused` audited with the cause. */
  dropFailed(pid: string, error: ErrorCode): Promise<Result<PhoneView>>;
  /** Mints one more link for an approved file (a download, the PDF or image view, a relaunch) and pushes it; `item` null is the first file. */
  mintFallback(sid: string, mode: OpenMode, item: number | null): Promise<Result<LinkResponse>>;
  /** An /f/ request arrived. Applies the link rules without counting, audits a refusal, and answers the purpose: the route rate-limits next. */
  checkLink(tokenHash: string, ipHash: string, via: { method: string; client: "office" | "browser" | "other" }): Promise<Result<{ purpose: OpenMode }>>;
  /**
   * Applies the link rules again, counts the fetch, audits it, and moves the session to open on the first accepted
   * one. A hash that names no link is link_unknown whatever the reason (OPEN-01).
   */
  useLink(tokenHash: string, ipHash: string, via: { method: string; client: "office" | "browser" | "other" }): Promise<Result<UsedLink>>;
}
/** What an accepted /f/ request needs: the file the link's item names, the link's purpose, and whose account reads it (Graph). */
export interface UsedLink { file: FileRef; purpose: OpenMode; mode: Mode; userId: string | null; }

/**
 * One instance. Routes typed codes; counts misses exactly (ADR 0002). An expired code keeps routing to its
 * screen for 5 min, so a late phone gets `code_expired` from the Screen, not a counted `code_unknown`.
 * A claimed code stays too, so a replay gets `code_taken`. `remove` runs when a screen retires a code
 * without a claim (cancel, Start Over, end).
 */
export interface CodeDirectory {
  /** `demo` is the screen's mode: the claim route reads it back to apply the demo claim limit and the off switch. */
  put(code: string, screenRef: string, expiresAt: number, demo: boolean): Promise<"ok" | "collision">;
  lookup(code: string, ipHash: string, now: number):
    Promise<{ ok: true; screenRef: string; demo: boolean } | { ok: false; error: "code_unknown" | "rate_limited" }>;
  remove(code: string): Promise<void>;
}

/** The limits on concurrent demo screens, in the same object (`do/demo-slots.ts`). */
export interface DemoCap {
  /** False when `cap` screens already hold a slot, or this IP hash already holds `perIp`. A slot lapses after `holdMs` (a claim window plus one session), or on release. */
  demoReserve(screenRef: string, ipHash: string, holdMs: number, cap: number, perIp: number): Promise<boolean>;
  /** Called when a demo session ends and when a demo screen closes. */
  demoRelease(screenRef: string): Promise<void>;
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
  /** Graph only: the one folder listing is limited to (token_grant.folder_id). Null lists the drive root. */
  folderId: string | null;
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
  /** At most `limit` files, newest edit first. Never .pptm or macro-enabled types. */
  listRecent(ctx: SourceContext, limit: number): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  /** Called at fetch time (the /f/ request), never at approve time: download URLs expire in minutes. */
  resolve(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  /** A PDF rendition, for the last fallback. Graph converts it; mock serves a fixture. */
  resolvePdf(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
}

/** The demo account and local runs. Default. `demo.ts` builds it from a real deck, its PDF export and a photo in
 *  src/worker/seams/file-source/demo-files/, imported as raw bytes through the `rules` entry in wrangler.jsonc:
 *  Sample deck.pptx, Sample deck.pdf (also the deck's rendition) and Dog.jpg. `DEMO_LINKS` beside it is the
 *  account's one link, Vevox (`https://www.vevox.com/`). */
export interface MockFixture {
  id: string; name: string; type: FileType; bytes: Uint8Array;
  editedMinutesAgo: number;     // listed relative to now, so the list always looks recent
  pdfId: string | null;         // the fixture served as this file's PDF; a PDF is its own rendition
}
export declare class MockFileSource implements FileSource {
  readonly kind: "mock";
  constructor(fixtures: readonly MockFixture[], now?: () => number);
  listRecent(ctx: SourceContext, limit: number): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  resolve(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  resolvePdf(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
}

/** Off until the Entra app exists (FILE_SOURCE=graph). Maps Graph 401 to auth_required, 403 with
 *  consent errors to admin_consent_required, 404 to file_not_found, 429 and 503 to source_throttled. */
export declare class GraphFileSource implements FileSource {
  readonly kind: "graph";
  constructor(opts: { fetch: typeof fetch; downloadHosts: readonly string[] });
  listRecent(ctx: SourceContext, limit: number): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  resolve(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  resolvePdf(ctx: SourceContext, fileId: string): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
}
```
`GraphFileSource` (implemented, contract-tested against synthetic fixtures in `test/fixtures/graph/`):
- **Listing:** `GET /me/drive/{root|items/{folderId}}/children?$select=...&$orderby=lastModifiedDateTime desc&$top=100`, then filtered here to `.pptx` and `.pdf` files (children cannot be filtered by type server-side; a `.pptm`, a folder or any other type never appears) and cut to `limit`. Nothing is followed past the first 100 items.
- **Resolve:** `GET /me/drive/items/{id}?$select=...,@microsoft.graph.downloadUrl`. `url` is that annotation when its host matches `GRAPH_DOWNLOAD_HOSTS` over https (`*.x` matches subdomains), else `null`. `body()` streams `/me/drive/items/{id}/content`. A `.pptm` or folder is `file_type_refused`. An id outside `[A-Za-z0-9!_.~-]{1,256}` is `file_not_found` before any request.
- **PDF:** a PDF item is its own rendition; a deck uses `GET .../content?format=pdf` with `redirect: "manual"` and takes the `Location` as `url` when its host is allowed; a failed conversion is `pdf_unavailable`.
- **Errors:** 401 `auth_required`; 403 with `consent` in the body `admin_consent_required`, other 403 `source_unavailable`; 404 `file_not_found`; 429 and 503 `source_throttled`; anything else, and a network failure, `source_unavailable`.
- **Open items (need the Entra app, F-ENTRA):** whether this listing works for both work and personal accounts, whether `/me/drive/recent` is a better call, and whether `Files.Read.Selected` can serve this flow (unverified).

`source-access.ts` picks the source: `MockFileSource` for a demo screen and whenever `FILE_SOURCE=mock`; `GraphFileSource` only for a live screen under `FILE_SOURCE=graph`, for the user the session cookie names. `Access.links` holds the account's web links: `DEMO_LINKS` for the mock source, none for Graph. `listEntries` is the phone's list: `listRecent` (5 files), then every link `allowedLink` accepts, carrying the URL it normalized. `resolveListed` runs the same list at approve and builds an `ItemRef` from each entry whose id matches, so the client's ids are the only thing trusted and an id not in the list is `file_not_found`.

## 4. `OpenPath` (`src/worker/seams/open-path/`)
Minting and the link rules do not depend on the mode, so they are plain functions in `links.ts`; the seam (`index.ts`) is only how an accepted request is answered. `select.ts` picks the class from `OPEN_PATH_MODE`.
```ts
import type { OpenMode, SourceError } from "../../../shared/protocol.ts";
import type { Resolved } from "../file-source/index.ts";

export interface OpenPath {
  readonly mode: "redirect" | "stream";
  /** Serves an accepted GET or HEAD. The caller already ran the link rules and resolved the file. */
  serve(request: Request, file: Resolved, purpose: OpenMode): Promise<Response>;
}

/** A missing file stays 404; any other source failure is 502 upstream_failed. */
export declare function sourceFailure(error: SourceError | "pdf_unavailable"): Response;

/** 302 to the source's own URL, after checking its host against GRAPH_DOWNLOAD_HOSTS again (502 otherwise). A source with no URL (mock, guest) streams. */
export declare class RedirectOpenPath implements OpenPath { /* ... */ }
/** The bytes through the Worker: Content-Type fixed per FileType (`CONTENT_TYPES`; images `image/jpeg`, `image/png`), Content-Length when known, attachment (inline for purposes "pdf" and "view"), no-store; HEAD answers from the metadata. */
export declare class StreamOpenPath implements OpenPath { /* ... */ }
```
`links.ts` (`src/worker/seams/open-path/links.ts`):
```ts
export interface MintedLink { token: string; tokenHash: string; purpose: OpenMode; url: string; }   // url: https://<host>/f/<token>/<slug>.<ext>, at most 200 characters
/** download stays download; a PDF is always "pdf"; an image is always "view"; a deck's "view" is its "pdf" rendition. */
export declare function effectivePurpose(type: FileType, purpose: OpenMode): OpenMode;
/** token = screenRef (22) + 32 base64url characters (192 bits) of secret, for `effectivePurpose(file.type, purpose)`. */
export declare function mintLink(screenRef: string, file: FileRef, purpose: OpenMode, origin: string): Promise<MintedLink>;
export declare const protocolUri: (url: string) => string;      // "ms-powerpoint:ofv|u|" + url
export declare function parseToken(token: string): { screenRef: string } | null;
export declare function refusal(rec: LinkRecord, now: number, limits: LinkConfig): OpenError | null;   // revoked, exhausted, expired
export declare function clientClass(userAgent: string | null): "office" | "browser" | "other";
```
`do/ledger.ts` keeps the `LinkRecord`s in the Screen object (`tokenHash`, `purpose`, `item`, `mintedAt`, `firstFetchAt`, `fetches`, `revoked`, and a view link's audit state: `ips`, the foreign IP hashes already audited, at most 16, and `refused`, whether a refusal was, and an optional `sessionId`, the session that minted it: a refusal is audited against that session, never the screen's next pairing, and a record without one writes no row); `item` is the index of the file the link serves. `check` applies the rules and counts nothing; `use` checks a link and counts the fetch in one synchronous step, so two requests cannot take the last allowed fetch. A view link audits its first fetch, the first fetch from each foreign IP hash and its first refusal; every other link audits every fetch and refusal. `revokeAll` marks records revoked and keeps them until the next `add`, which drops every revoked record first (they belong to an ended session), so the stored set is one session's worth and an earlier session's token is `link_unknown`.

The status of each `/f/` refusal is the one in `public/js/shared/errors.js` (`link_unknown` 404, `link_expired`, `link_exhausted` and `link_revoked` 410, `link_binding_failed` 403, `upstream_failed` 502, `pdf_unavailable` 404, `mint_limit` 429); 410 tells Office the file is gone for good. The name segment of the link comes from `public/js/shared/names.js`: `[A-Za-z0-9-]`, 1 to 60 characters, no dots except the extension, sized so the whole link fits 200 characters for the configured origin (`PUBLIC_ORIGIN` is capped at 120 characters), which keeps the `ms-powerpoint:ofv|u|` URI under Office's 256.

Screen side (`public/js/launcher.js`; its types are in `public/js/types.d.ts`; `createLauncher(deps)` takes every browser effect as a dependency, so it is unit tested without a browser):
```ts
/** Launch ladder: protocol, with Download beside it at once, then the PDF view. Each link is acted on once, whether it arrived as an `open` frame or as a /api/screen/link answer. */
type Minted = "ok" | "spent" | "failed";
export interface ScreenLauncher {
  launch(links: LinkSet, item?: number): void; // protocol: location.assign + one "launched" report; pdf and view (an image): window.open("bloop-pdf"), reported as pdf or view; download: <a download>. The demo passes pdf and view to the viewer instead (`viewer.js`: a HEAD for a PDF, the stage canvas for an image, a <video> for a video); a live screen passes a guest's view link (a photo or video) to it too
  click(): void;                           // the Open control: launch again, or open a PDF the popup blocker refused, under a user gesture
  download(item?: number): Promise<Minted>; // the link it started for that item under a minute ago again (3 starts at most), else POST /api/screen/link {purpose:"download", item} (no item: the first file) and launch the answer
  showPdf(): Promise<Minted>;              // POST /api/screen/link {purpose:"pdf"}
  relink(item: number): Promise<Minted>;   // POST /api/screen/link {purpose:"protocol", item}: another item's launch link (an image's view link), no mode change
  spent(item?: number): boolean;           // a mint for that item (none: the first file) met `mint_limit`, which is per item: the page hides that item's Download and Show as PDF Instead, flags no error
  onView(view: ScreenView): void;          // recovers a lost link (approved with a file, no link after 1.5 s; a links-only session mints none), resets at the end
  needsClick(): boolean;                   // the launch had no user activation, or a popup was blocked
  left(): { ppt: boolean; download: string | null }; // read when the view turns ended, before reset: PowerPoint was launched; the started download's name (its link's last segment), for the line under Session Ended
  closePdf(): void;
  reset(): void;
}
```

## 5. `GuestDrop` (`src/worker/seams/guest-drop/index.ts`)
```ts
import type { DropError, FileType, Mode } from "../../../shared/protocol.ts";

export type GuestPolicy = "off" | "pass" | "open";
/** A demo screen always takes drops; a live room uses its own policy, else the configured GUEST_DROP. */
export const effectivePolicy: (room: GuestPolicy | null, mode: Mode, configured: GuestPolicy) => GuestPolicy;

export type Reservation = { ok: true; r2Key: string } | { ok: false; error: DropError };

export interface Upload {
  sessionKey: string;          // the session id: ties the object to its session for deletion by session
  r2Key: string;               // from reserve()
  name: string;                // the sanitized display name (X-Bloop-Name, percent-decoded, cleanName); its extension is the declared type
  declaredType: FileType;
  length: number;              // Content-Length, required; the stream is fixed to it
  body: ReadableStream<Uint8Array>;
}
export interface GuestFile { r2Key: string; name: string; type: FileType; bytes: number; sha256: string; }

export interface GuestDrop {
  /** Picks the key (`g/<128-bit random>`) and reserves budget in one statement: `storage_full` when live bytes would pass the budget. */
  reserve(sessionId: string, bytes: number, name: string, type: FileType): Promise<Reservation>;
  /** Streams to storage through a fixed-length stream and a digest, then validates by range reads. Deletes on any failure. */
  accept(u: Upload, maxBytes: number): Promise<{ ok: true; file: GuestFile } | { ok: false; error: DropError }>;
  /** Throws `QuotaExhausted` (exported here) when the month's R2 class B cap is reached; reserve answers `storage_full` at either cap. */
  read(r2Key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  delete(r2Key: string): Promise<void>;          // idempotent
  /** Deletes the session's object and closes its ledger row, by key and by session id. True when something existed. Idempotent. */
  purge(sessionId: string | null, r2Key: string | null): Promise<boolean>;
  /** Hourly backstop: deletes objects older than the given age and closes rows that old. Returns the object count. */
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
  ratioFloorBytes: 64 * 1024,           // the ratio rule applies to entries at least this large
  maxContentTypesBytes: 256 * 1024,     // the one part inflated, to read its content types
  requiredParts: ["[Content_Types].xml", "ppt/presentation.xml"],
  refusedParts: [/^ppt\/vbaProject\.bin$/i, /^ppt\/activeX\//i, /\.bin$/i],
  refusedContentTypes: [/macroEnabled/i, /vbaProject/i],
} as const;                              // Zip64, multi-disk and encrypted entries are always refused
```
Validation rules: a `.pptx` starts with `PK\x03\x04`, has no `%PDF` in its first 1 KB, has an EOCD record (its comment length reaching the end of the file) whose central directory is inside the file and within the limits, uses only stored or deflate entries, and passes the part, content-type and relationship rules (`checkOoxml`: no macro or control part or relationship, no external relationship but a hyperlink, no two parts of one name, no `\` or `%` in a name). A `.pdf` starts with `%PDF-`, has `%%EOF` in its last 1 KB, and has no plausible ZIP EOCD in its last 64 KB. The extension must match the detected type (`bad_type` otherwise; a structure failure is `bad_structure`, a macro part or content type `macro_content`). A `.jpg` or `.jpeg` starts with `FF D8 FF`, has the end marker `FF D9` in its last 1 KB and no ZIP EOCD in its last 64 KB; a `.png` starts with the 8-byte PNG signature, ends with its `IEND` chunk and has no ZIP EOCD. HEIC (a `.heic` name, or `ftyp` bytes under an image name) is `bad_type`, as is any pair of declared and detected types that differ; no error code is added. The phone re-encodes a photo to JPEG before upload (it drops metadata, shrinks the body, and removes any trailer such as a Motion Photo's appended video); the server never relies on it for safety and checks the bytes and the size cap on every upload, so an API client that sends a JPEG with a trailer past its end marker gets `bad_structure`. A JPEG or PNG with `%PDF` in its first 1 KB or `%%EOF` in its last KB is `bad_structure` too (DROP-11). A `.mp4` or `.mov` has an `ftyp` box at offset 4 whose major brand is `isom`, `iso2`, `iso4`, `iso5`, `iso6`, `mp41`, `mp42`, `mp71`, `avc1`, `dash`, `M4V `, `M4VP`, `3gp4`, `3gp5` or `XAVC` (`.mp4`), or `qt  ` (`.mov`); the box is well formed and followed by a movie, data, fragment, index or metadata box (`moov`, `mdat`, `moof`, `sidx`, `pdin`, `meta`) or a padding box, with no `%PDF` in the first 1 KB, and no ZIP EOCD in the last 64 KB or `%%EOF` in the last KB. `/f/` answers a video's single `Range` (206; 416 for a well-formed range out of bounds; a malformed or multiple range is ignored and answered 200 whole) and HEAD, through `Resolved.body(range?)` and `GuestDrop.read(key, range?)`; every other type is answered whole. `Content-Type` on the way out comes from the detected type (video is always `video/mp4`), never from the upload.

`purgeGuest` (`seams/guest-drop/purge.ts`) is what the Screen object's `purge` seam runs: it skips a file from another source, deletes through `GuestDrop.purge`, audits `guest.deleted` when something existed, and never throws (a failed delete is logged and left to the sweep).

## 6. `Residue` (`public/js/residue.js`; the server half is `revokeLinks` and `purge` in `do/effects.ts`)
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

/** Screen side. `clear` runs on "ended" and "closed" (the page re-stores its own credential when the screen waits again, so a reload resumes the screen); pagehide only closes the PDF window. A stored sid resumes only a screen of the page's own mode; a screen of the other mode that still exists is ended (`POST /api/screen/end`) and then `forget` runs; the demo's one-device round trip (`/s?mode=demo` to `/a` and back in one tab) is that resume. The pid is in `localStorage` (`pidStore`), so the screen page drops it itself on "ended" and "closed", and only when it names this screen (`sameScreen`; the phone uses `dropPid`, which compares the value). Back and End Session leave through one helper: it stops the socket and bumps the boot generation, ends the screen when asked (`POST /api/screen/end` with `keepalive`: End Session always, Back only from waiting), and runs `clear` before the navigation, whether or not the end succeeds, then drops the one-device pid when it names this screen (the same check as on "ended"). A page restored from the back-forward cache reloads. The sid is stored only once its boot's generation is still current. New Code on a waiting screen is the same pair of calls: `POST /api/screen/end` (which closes a waiting screen), then the boot path creates a new one; no route of its own. A renew bumps a generation: a boot or channel of an older screen stops acting. */
export interface ScreenResidue {
  clear(): void;               // launcher.reset (links, timers, the PDF window this page opened), sessionStorage bloop.*,
                               // history.replaceState to the same path and query (the demo mode stays)
  forget(): void;              // the stored sid and sessionStorage bloop.* only, for a credential the page drops at boot
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

/** Lets the first event create the `session` row; later events find it by sessionId. Set by the machine's effects. */
export interface SessionContext { screenRef: string; roomId: string | null; mode: Mode; kind: Kind; userId: string | null; }

export interface AuditEvent {
  sessionId: string; at: number; actor: Actor; session?: SessionContext;
  type: AuditType | "grant.created" | "grant.deleted" | "user.erased" | "export.run" | "pass.created";
  /** Allowed keys only. Never tokens, codes, URLs, IPs or Graph ids. */
  detail: { fileName?: string; source?: "mock" | "graph" | "guest"; purpose?: string;
            cause?: ErrorCode; reason?: string; bytes?: number; ipMatch?: boolean; endsAt?: number; /* session.length: the new end */
            /** An /f/ request: method, class of client (never the raw User-Agent), fetch count. */
            method?: string; client?: "office" | "browser" | "other"; count?: number };
}
/** mode and kind are null for a row with no session (an export run). */
export interface AuditRow extends Omit<AuditEvent, "session"> { id: number; roomName: string | null; userEmail: string | null; mode: Mode | null; kind: Kind | null; }

export interface AuditLog {
  record(e: AuditEvent): Promise<void>;
  /** The user's session rows and their account rows (`sessionId` = `userScope(userId)`), newest first. */
  forUser(userId: string, limit: number, before?: number): Promise<AuditRow[]>;
  /** IT export of [from, to), paged out of D1 as a stream. CSV cells starting with = + - @ tab or CR get a leading apostrophe. */
  export(q: { orgId: string | null; from: number; to: number; format: "csv" | "json" }): Promise<ReadableStream<Uint8Array>>;
  purge(now: number, retention: { liveDays: number; demoDays: number }): Promise<number>;
  /** Erasure: keeps session, room and time; drops user id and file name. */
  anonymizeUser(userId: string): Promise<number>;
}

export type FailureCause = ErrorCode | "screen_offline" | "phone_offline";
export interface MetricEvent { at: number; mode: Mode; kind: Kind; roomId: string | null; name: MetricName; ms?: number; cause?: FailureCause; }

/** `cause` is "" when there is none. Percentiles are nearest-rank over the rows that carry a duration. */
export interface MetricSummary { mode: Mode; name: MetricName; cause: string; n: number; p50Ms: number | null; p90Ms: number | null; }

export interface Metrics {
  record(e: MetricEvent): Promise<void>;
  /** Week-3 return: one row per pseudonymous user per ISO week, pseudonym = HMAC(HASH_PEPPER, user id). */
  activeWeek(userId: string, now: number): Promise<void>;
  /** Time to first open and failures by cause over [from, to), from metric_event (the retention window). */
  summary(from: number, to: number): Promise<MetricSummary[]>;
  rollup(day: string): Promise<void>;     // metric_event to metric_daily, replacing that day
  /** Rolls each event day older than `days` into metric_daily, then deletes those events; also drops daily counts past 2 years and weeks past 120 days. */
  purge(now: number, days: number): Promise<number>;
}
```

Implementations: `audit-d1.ts` (`D1AuditLog`) and `metrics-d1.ts` (`D1Metrics`), picked in `stores.ts`. The `session` row is created by the first event that carries a `SessionContext` (`claimed`) and updated by `approved`, `guest.uploaded`, `link.fetched` (first open), `ended` and `canceled`. A demo session never keeps a user id. `detail` is filtered to the keys of `AuditEvent["detail"]` before the write. The `failure` metric carries the cause: a refused guest upload (`upload.failed`) and a refused `/f/` request (`link.refused`). `screen_offline` and `phone_offline` causes have no emitter yet.

`GET /api/it/export` (`routes/export.ts`): Bearer `IT_EXPORT_TOKEN`; query `format=json|csv` (default json), `data=audit|metrics` (default audit), `from` and `to` as inclusive UTC days (default: the last 30 days; at most 366 days); `RL_EXPORT` per pseudonymous IP; each run writes an `export.run` row (actor `it`, session id `export`) first. Audit CSV columns: `id,time,session,room,mode,kind,actor,type,user,file_name,source,purpose,cause,reason,bytes,ip_match,method,client,count,ends_at`; metrics: `mode,name,cause,n,p50_ms,p90_ms`.

Cron (`cron-jobs.ts` lists the jobs, `index.ts` `scheduled` dispatches; the five-minute trigger has no job yet): hourly `0 * * * *` runs the guest sweep and `closeStaleSessions(env, now)`; daily `30 3 * * *` runs `runRetention(env, config, now)`, which returns a report of rows deleted per table and the auth maintenance report. Both are plain functions with the clock passed in.

## 8. Error codes, HTTP status and user-facing state
The table is `ERRORS` in `public/js/shared/errors.js`, the only owner: each `ErrorCode` (type in section 1) maps to its HTTP status and to the phone and screen state it shows. Both the Worker and the browser import it. A code that never reaches a person has `null` for that side; `status: 0` marks a client-only code the server never sends. `test/unit/docs-drift.test.ts` fails if this section lists codes.

## 9. Strings the design still needs
The shared state strings have no slot for these. Wording is a design.md decision, so these are proposals only:
- `rate_limited` (phone): "Too many tries." / "Wait a minute, then scan the code again."
- `guest_pass_needed` (phone): "Ask your host for a guest link." / "Open it on this phone, then scan the code again."
- `busy` (phone): "bloop can't take files right now." / "Try again in a few minutes."
- Screen `guest_open` (offered state): heading "{file name}", line "Sent by a guest. Open it here when you're ready.", control "Open". The click is the proof of presence at the lectern, and no guest file opens without it.
- Screen "Start Over" (decided, OD-6; the labeled Back pill in the scanned, choosing and offered states): ends a claim nobody at the lectern recognizes (PAIR-02).
- `guest_refused` and the "File Too Large" toast fill `{N}` from `PhoneView.dropMaxBytes` (`GUEST_MAX_BYTES`, default 90 MB; demo 25 MB), in whole megabytes. The phone states no cap of its own.
- Added with the guest drop (module f), now in design.md section 7: `guest_sent` (phone, after the upload: "Sent to {room}." / "Open it on the screen when you're ready.", Cancel) and the text action "Send a File Instead", which is how a phone that scanned as an owner chooses to send its own file.
