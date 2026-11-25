// Contracts shared by the Worker and the browser modules (JSDoc @import). Never served. Type-only, except the value
// lists the Worker's schemas build from (OPEN_MODES), so a list is written once.
// Source of truth for the wire format: docs/interfaces.md section 1.

export type Mode = "live" | "demo";
export type Kind = "owner" | "guest";
export type FileType = "pptx" | "pdf" | "jpg" | "png" | "mp4" | "mov";
/** `view` is an image shown in the screen page; `pdf` a PDF file's own view or a deck's rendition. */
export const OPEN_MODES = ["protocol", "download", "pdf", "view"] as const;
export type OpenMode = (typeof OPEN_MODES)[number];
export type EndReason = "phone" | "screen" | "auto" | "canceled" | "claim_timeout" | "error";
export type Actor = "screen" | "phone" | "system" | "host" | "it";

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/** Session states owned by the Screen object (section 2). */
export type SessionState =
  | "waiting"
  | "claimed"
  | "choosing"
  | "uploading"
  | "offered"
  | "approved"
  | "opening"
  | "open"
  | "ended"
  | "closed";

export interface RoomView {
  name: string;
  registered: boolean;
}
export interface CodeView {
  code: string;
  expiresAt: number;
  qrUrl: string;
}

/** One approved file: what a page may show of it. No source id or URL (SRC-01). */
export interface FileItem {
  kind: "file";
  /** Server-assigned and opaque, unique in the session, fixed at approval; never derived from the source or an index. */
  id: string;
  name: string; // display name
  type: FileType; // an original PDF shown as a PDF is not a fallback
  size: number | null; // bytes, when the source gave a size
}
/** One approved web link: https on an allowed host only (LINK-01). The screen shows a card, never a frame. */
export interface LinkItem {
  kind: "link";
  id: string; // as on FileItem
  url: string;
  title: string;
}
export type Item = FileItem | LinkItem;

/** What the screen shows: `shown` in both views, and the body of the remote's two routes (`ShownCommand`). */
export interface Shown {
  item: string; // a file item's id
  page: number; // 1-based, within the item's pages
  present: boolean;
}

/**
 * The body of `POST /api/control` (phone, pid) and `POST /api/screen/shown` (screen, sid). Absolute, so a replay
 * changes nothing. `seq` grows with each command from one sender, across reloads too (the sender's clock in ms does),
 * and a command whose `seq` is not above the last one applied from that sender changes nothing (PAIR-13).
 */
export interface ShownCommand extends Shown {
  seq: number;
}

export interface ScreenView {
  state: SessionState;
  mode: Mode;
  kind: Kind | null;
  room: RoomView;
  code: CodeView | null; // only in "waiting" and "ended"
  match: string | null; // 2 digits, from "claimed" to "open"
  /** From "offered" (guest) or "approved"; files by name, then links by title. A link or mint names an item by its index here. */
  items: Item[];
  /** Null until the remote or the screen's own tap sets it; null outside an approved session. */
  shown: Shown | null;
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
  items: Item[]; // as in ScreenView
  shown: Shown | null; // as in ScreenView
  openMode: OpenMode | null;
  /** Epoch ms the session ends by itself; with `now`, the phone's countdown. */
  endsAt: number | null;
  endReason: EndReason | null;
  /** The largest guest file this screen takes (GUEST_MAX_BYTES, or the demo cap). */
  dropMaxBytes: number;
  now: number;
}

/** One mint fills one field: the link for the purpose asked, the others stay null. */
export interface LinkSet {
  protocol: string | null; // ms-powerpoint:ofv|u|<url>, pptx only
  download: string | null;
  pdf: string | null; // a PDF file's own view, or a deck's PDF rendition
  view: string | null; // an image, inline
}

// WebSocket frames, all {v: 1, t: ...}, at most 4 KB. The upgrade URL carries the non-secret screenRef
// (`/api/screen/ws?ref=<screenRef>`, `/api/pair/ws?ref=<screenRef>`): the first frame is the credential.
// The exact text {"v":1,"t":"ping"} is answered with {"v":1,"t":"pong"} by the runtime without waking the object.
export type ScreenMsgIn =
  | { v: 1; t: "hello"; sid: string }
  | { v: 1; t: "code.next" }
  | { v: 1; t: "open.click" } // the Open button on a guest offer
  | { v: 1; t: "launched"; mode: OpenMode }
  | { v: 1; t: "ping" };
export type ScreenMsgOut =
  | { v: 1; t: "state"; view: ScreenView }
  | { v: 1; t: "open"; item: number; links: LinkSet; now: number } // item: index into ScreenView.items
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };
export type PhoneMsgIn = { v: 1; t: "hello"; pid: string } | { v: 1; t: "ping" };
export type PhoneMsgOut =
  | { v: 1; t: "state"; view: PhoneView }
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };

export interface ClaimRequest {
  code: string;
  pass?: string;
  kind?: Kind; // defaults to "owner"; "guest" asks for the drop path
}
export interface ClaimResponse {
  pid: string;
  room: RoomView;
  match: string;
  mode: Mode;
  kind: Kind;
  needsAuth: boolean;
  dropMaxBytes: number;
}
/** A row of the phone's list (`GET /api/files` answers `{items: Entry[]}`); approve names entries by id. */
export interface FileEntry extends Omit<FileItem, "id"> {
  id: string; // the source's id (an entry id, not an item id); opaque to the phone; never a Graph URL
  modifiedAt: number;
}
export interface LinkEntry extends Omit<LinkItem, "id"> {
  id: string;
}
export type Entry = FileEntry | LinkEntry;
/** `POST /api/approve`: one to MAX_ITEMS distinct entry ids. */
export interface ApproveRequest {
  ids: string[];
}
/** `POST /api/screen/link`: item defaults to the one the approval launched (the first file). */
export interface LinkRequest {
  purpose: OpenMode;
  item?: number;
}
export interface LinkResponse {
  item: number;
  links: LinkSet;
}

export type PairError =
  | "code_malformed"
  | "code_unknown"
  | "code_expired"
  | "code_taken"
  | "rate_limited"
  | "pairing_invalid"
  | "screen_gone"
  | "wrong_state"
  | "session_ended";
export type SourceError =
  | "auth_required"
  | "admin_consent_required"
  | "consent_declined"
  | "no_files"
  | "file_not_found"
  | "file_type_refused"
  | "source_throttled"
  | "source_unavailable";
export type OpenError =
  | "link_unknown"
  | "link_expired"
  | "link_exhausted"
  | "link_revoked"
  | "link_binding_failed"
  | "upstream_failed"
  | "launch_timeout"
  | "pdf_unavailable"
  | "mint_limit";
export type DropError =
  | "drop_disabled"
  | "pass_required"
  | "pass_invalid"
  | "length_required"
  | "too_large"
  | "bad_type"
  | "bad_structure"
  | "macro_content"
  | "storage_full"
  | "upload_aborted"
  | "already_uploaded";
export type HttpError =
  | "bad_request"
  | "unsupported_media_type"
  | "forbidden_origin"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "internal";
export type ClientError = "offline" | "service_down";
export type ErrorCode = PairError | SourceError | OpenError | DropError | HttpError | ClientError;

/** Body of every error response (application/problem+json). */
export interface Problem {
  type: "about:blank";
  status: number;
  code: ErrorCode;
}

// User-facing state keys: the slots in the shared state strings (design.md section 7).
export type PhoneStateKey =
  | "checking"
  | "match"
  | "choose"
  | "approve"
  | "approve_demo"
  | "unregistered"
  | "first_use"
  | "needs_admin"
  | "empty"
  | "approving"
  | "opening"
  | "open"
  | "open_fallback"
  | "pdf_fallback"
  | "pdf_file"
  | "ended"
  | "canceled"
  | "expired"
  | "taken"
  | "offline"
  | "error"
  | "guest_add"
  | "guest_confirm"
  | "guest_sending"
  | "guest_refused"
  | "guest_sent"
  | "typed_wrong"
  | "framed"
  | "rate_limited"
  | "guest_pass_needed"
  | "guest_off"
  | "busy"; // last three: new strings, section 9
export type ScreenStateKey =
  | "waiting"
  | "scanned"
  | "choosing"
  | "approved"
  | "opening"
  | "open"
  | "open_fallback"
  | "pdf_fallback"
  | "pdf_file"
  | "guest_open"
  | "ended"
  | "offline"
  | "service_down"
  | "error"
  | "phone_width"
  | "rate_limited"
  | "demo_open"; // a demo screen shows the approved file in the page (DEMO-01)
