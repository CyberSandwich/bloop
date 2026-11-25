// Shared vocabulary of the wire format: modes, file types, errors and the user-facing state keys.
import type { AccountError, PairingAccountError } from "./account.ts";
import type { LibraryError } from "./library.ts";

export type Mode = "live" | "demo";
export type Kind = "owner" | "guest";
export type FileType = "pptx" | "pdf" | "jpg" | "png" | "mp4" | "mov";
/** `view` is a photo or video shown in the screen page; `pdf` a PDF file's own view or a deck's rendition. */
export const OPEN_MODES = ["protocol", "download", "pdf", "view"] as const;
export type OpenMode = (typeof OPEN_MODES)[number];
export type EndReason = "phone" | "screen" | "auto" | "canceled" | "claim_timeout" | "error";
export type Actor = "screen" | "phone" | "system" | "host" | "it";

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

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
/** The codes the phone and screen pages know (public/js/shared/errors.js). */
export type ErrorCode = PairError | SourceError | OpenError | DropError | HttpError | ClientError;

/** The codes of the account, library and spend routes (public/js/shared/errors-app.js); their pages carry their own copy. */
export type AppError = AccountError | LibraryError | PairingAccountError;

/** Body of every error response (application/problem+json). */
export interface Problem {
  type: "about:blank";
  status: number;
  code: ErrorCode | AppError;
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
  | "busy" // the three above: new strings, section 9
  | "service_down";
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
  | "demo_open"; // the page shows the approved file itself: a demo screen (DEMO-01), and a guest's photo or video anywhere
