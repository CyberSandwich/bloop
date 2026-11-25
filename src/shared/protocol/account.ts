// Accounts, sign-in, invites, the admin routes and the launch mode (ADRs 0013, 0014, 0026).

/** Accounts, sign-in, invites and the admin routes (ADRs 0013, 0014, 0026). */
export type AccountError =
  | "email_invalid"
  | "code_invalid"
  | "invite_dead"
  | "invite_refused"
  | "already_member"
  | "turnstile_failed"
  | "reauth_required"
  | "restore_too_late"
  | "gate_incomplete"
  | "forbidden"
  | "account_suspended"
  | "passkey_invalid";
/** Live pairing with accounts (ADR 0015) and the spend guard's refusal. */
export type PairingAccountError = "match_required" | "service_busy";

/** The launch mode (ADR 0026): preview shows today's product, open adds accounts, the library and the open pages. */
export type LaunchMode = "preview" | "open";
