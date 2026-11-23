// Type-only contracts shared by the Worker and the browser modules (JSDoc @import). Never served.
// Source of truth for the wire format: docs/interfaces.md section 1.

export type Mode = "live" | "demo";
export type Kind = "owner" | "guest";
export type FileType = "pptx" | "pdf";
export type OpenMode = "protocol" | "download" | "pdf";
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

export interface ScreenView {
  state: SessionState;
  mode: Mode;
  kind: Kind | null;
  room: RoomView;
  code: CodeView | null; // only in "waiting" and "ended"
  match: string | null; // 2 digits, from "claimed" to "open"
  fileName: string | null; // display name, from "offered" (guest) or "approved"
  fileType: FileType | null; // with fileName: an original PDF shown as a PDF is not a fallback
  fileSize: number | null; // bytes, with fileName when the source gave a size (the demo file card)
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
  fileType: FileType | null;
  openMode: OpenMode | null;
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
  | { v: 1; t: "open"; links: LinkSet; now: number }
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
export interface FileEntry {
  id: string; // opaque to the phone; never a Graph URL
  name: string; // display name
  type: FileType;
  modifiedAt: number;
  size: number | null;
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
  | "guest_choose"
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
