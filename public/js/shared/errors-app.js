// HTTP status of the account, library, upload and spend errors. Pure: shared by the Worker and the account pages, which
// carry their own copy per code. The phone and screen pages' codes live in errors.js, whose size is budgeted per page.
/** @import {AppError} from "../../../src/shared/protocol.ts" */

/** @type {Record<AppError, {status: number}>} */
export const APP_ERRORS = {
  // accounts, sign-in and admin
  email_invalid: { status: 400 },
  code_invalid: { status: 400 },
  invite_dead: { status: 410 },
  invite_refused: { status: 403 },
  already_member: { status: 409 },
  turnstile_failed: { status: 403 },
  reauth_required: { status: 401 },
  restore_too_late: { status: 410 },
  gate_incomplete: { status: 409 },
  forbidden: { status: 403 },
  account_suspended: { status: 403 },
  passkey_invalid: { status: 400 },
  account_deleting: { status: 403 },
  // library, uploads and conversion
  quota_exceeded: { status: 507 },
  library_full: { status: 409 },
  upload_not_found: { status: 404 },
  upload_expired: { status: 410 },
  part_invalid: { status: 400 },
  size_mismatch: { status: 422 },
  file_disabled: { status: 403 },
  convert_unavailable: { status: 503 },
  encrypted: { status: 422 },
  upload_busy: { status: 409 },
  upload_gone: { status: 410 },
  up_next_full: { status: 409 },
  export_busy: { status: 409 },
  export_limit: { status: 429 },
  export_paused: { status: 503 },
  // live pairing with accounts, and the spend guard's refusal
  match_required: { status: 409 },
  service_busy: { status: 503 },
};
