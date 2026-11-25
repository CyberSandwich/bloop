// Error code to HTTP status and user-facing state. Pure: shared by the browser and the Worker.
/** @import {ErrorCode, PhoneStateKey, ScreenStateKey} from "../../../src/shared/protocol.ts" */

/** @type {Record<ErrorCode, {status: number, phone: PhoneStateKey | null, screen: ScreenStateKey | null}>} */
export const ERRORS = {
  // pairing
  code_malformed: { status: 400, phone: "typed_wrong", screen: null },
  code_unknown: { status: 404, phone: "typed_wrong", screen: null }, // a QR scan shows "expired" instead
  code_expired: { status: 410, phone: "expired", screen: null },
  code_taken: { status: 409, phone: "taken", screen: null },
  rate_limited: { status: 429, phone: "rate_limited", screen: null },
  pairing_invalid: { status: 401, phone: "expired", screen: null },
  screen_gone: { status: 410, phone: "expired", screen: "service_down" },
  wrong_state: { status: 409, phone: "taken", screen: null },
  session_ended: { status: 410, phone: "ended", screen: "ended" },
  // file source
  auth_required: { status: 401, phone: "first_use", screen: null },
  admin_consent_required: { status: 403, phone: "needs_admin", screen: null },
  consent_declined: { status: 403, phone: "canceled", screen: null },
  no_files: { status: 200, phone: "empty", screen: null },
  file_not_found: { status: 404, phone: "error", screen: "error" },
  file_type_refused: { status: 415, phone: "error", screen: null },
  source_throttled: { status: 503, phone: "error", screen: "error" },
  source_unavailable: { status: 502, phone: "error", screen: "error" },
  // open path (the /f/ client is PowerPoint; these states reach people through the Screen object)
  link_unknown: { status: 404, phone: null, screen: "error" },
  link_expired: { status: 410, phone: null, screen: "error" },
  link_exhausted: { status: 410, phone: null, screen: "error" },
  link_revoked: { status: 410, phone: "ended", screen: "ended" },
  link_binding_failed: { status: 403, phone: null, screen: "error" },
  upstream_failed: { status: 502, phone: "error", screen: "error" },
  launch_timeout: { status: 504, phone: "open_fallback", screen: "open_fallback" },
  pdf_unavailable: { status: 404, phone: "error", screen: "error" },
  mint_limit: { status: 429, phone: null, screen: "error" },
  // guest drop
  drop_disabled: { status: 403, phone: "guest_off", screen: null },
  pass_required: { status: 403, phone: "guest_pass_needed", screen: null },
  pass_invalid: { status: 403, phone: "guest_pass_needed", screen: null },
  length_required: { status: 411, phone: "guest_refused", screen: null },
  too_large: { status: 413, phone: "guest_refused", screen: null },
  bad_type: { status: 415, phone: "guest_refused", screen: null },
  bad_structure: { status: 422, phone: "guest_refused", screen: null },
  macro_content: { status: 422, phone: "guest_refused", screen: null },
  storage_full: { status: 507, phone: "busy", screen: null },
  upload_aborted: { status: 400, phone: "error", screen: null },
  already_uploaded: { status: 409, phone: "taken", screen: null },
  // http
  bad_request: { status: 400, phone: "error", screen: "error" },
  unsupported_media_type: { status: 415, phone: "error", screen: "error" },
  forbidden_origin: { status: 403, phone: "error", screen: "error" },
  unauthorized: { status: 401, phone: "expired", screen: "error" },
  not_found: { status: 404, phone: "error", screen: "error" },
  method_not_allowed: { status: 405, phone: "error", screen: "error" },
  internal: { status: 500, phone: "service_down", screen: "error" },
  // client only, never sent by the server
  offline: { status: 0, phone: "offline", screen: "offline" },
  service_down: { status: 0, phone: "service_down", screen: "service_down" },
};

export const SUPPORT = "hi@bloop.here";
// The support line (design.md section 3).
export const orEmail = (/** @type {string} */ retry) => `${retry}, or email ${SUPPORT}.`;
export const DOWN = "Something's wrong on bloop's side.";
