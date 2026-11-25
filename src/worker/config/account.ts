// Accounts, sign-in, invites, email and the admin and test address lists (ADRs 0013, 0014, 0026).
import { z } from "zod";
import { int, optional } from "./core.ts";

export const accountVars = {
  ACCOUNT_DELETE_GRACE_DAYS: int(1, 90)
    .default(7)
    .describe("A requested account deletion can be cancelled for this long, then the purge runs."),
  INVITE_TTL_DAYS: int(1, 30).default(7).describe("An invite link works this long."),
  EMAIL_CODE_TTL_SECONDS: int(60, 3600).default(600).describe("An emailed code works this long."),
  REAUTH_SECONDS: int(30, 3600)
    .default(300)
    .describe("A fresh proof (code or passkey) unlocks sensitive account actions this long."),
  EMAIL_FROM: z.email().default("hi@bloop.here").describe("The sender of every bloop email."),
  TURNSTILE_SITE_KEY: optional(z.string().min(1)).describe(
    "The public Turnstile widget key; unset means the widget is not rendered.",
  ),
  DEV_MAILBOX: z
    .enum(["0", "1"])
    .default("0")
    .describe(
      "Test only. 1 keeps outgoing mail in memory and serves it at GET /api/dev/mailbox; refused unless PUBLIC_ORIGIN is a local address.",
    ),
  CODE_PEPPER: optional(z.string().min(32)).describe(
    "Secret. 32 random bytes that key the email-code MACs and the known-device cookie; at least 32 characters.",
  ),
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)).describe("Secret. Turnstile server key for siteverify."),
  TALLY_SIGNING_SECRET: optional(z.string().min(1)).describe(
    "Secret. Signs the Tally waitlist webhook; the webhook fails closed while it is unset.",
  ),
  ADMIN_EMAILS: optional(z.string()).describe(
    "Secret. Comma-separated addresses that hold the admin role, checked per request (ADR 0014). An entry that does not normalize admits nobody.",
  ),
  TEST_EMAILS: optional(z.string()).describe(
    "Secret. Comma-separated test addresses: the only invitees and sign-ins in preview mode (ADR 0026).",
  ),
};

/** Account and sign-in settings (ADRs 0013, 0014, 0026). */
export interface AccountConfig {
  inactiveDays: number;
  inactiveGraceDays: number;
  deleteGraceDays: number;
  inviteTtlDays: number;
  codeTtlSeconds: number;
  reauthSeconds: number;
  emailFrom: string;
  turnstileSiteKey: string | null;
  /** Normalized, so a lookup is `.has(emailNorm)`. */
  adminEmails: ReadonlySet<string>;
  testEmails: ReadonlySet<string>;
  devMailbox: boolean;
}
