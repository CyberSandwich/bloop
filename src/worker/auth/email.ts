// The one way mail leaves bloop (ADR 0021): the `email` switch, then the spend takes, then the Email Service binding,
// all inside ctx.waitUntil so no response waits on mail or reveals by its timing whether mail was sent (AUTH-10).
import type { AccountConfig } from "../config/account.ts";
import type { Db } from "./db.ts";
import { normalizeEmail } from "./email-norm.ts";
import { type Email, spendAlert, type TemplateConfig } from "./templates.ts";

/** A rendered email and its one recipient. `codeScope` (the IP hash) marks a code request, which also takes `email_code`. */
export interface Message extends Email {
  to: string;
  codeScope?: string;
}

/** The `email` switch (docs/spend.md): admin_only mails ADMIN_EMAILS recipients only. */
export type EmailSwitch = "on" | "admin_only" | "off";

/** The slice of the spend client mail uses (src/worker/spend/client.ts); `unavailable` means the guard is unreachable. */
export interface EmailSpend {
  take(
    meter: "email" | "email_code",
    n: number,
    scope?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; retryAfterSeconds?: number }>;
}

/** The Email Service binding (env.EMAIL) as mail calls it. */
export interface Sender {
  send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface MailDeps {
  account: Pick<AccountConfig, "emailFrom" | "adminEmails" | "devMailbox">;
  sender: Sender | undefined;
  spend: EmailSpend;
  emailSwitch: EmailSwitch;
}

/** Sends admitted while the spend guard is unreachable, per isolate per window: code sign-in survives an outage. */
export const GUARD_DOWN_CAP = 20;
export const GUARD_DOWN_WINDOW_MS = 600_000;
const open = { since: 0, sent: 0 };

function guardDownSlot(now: number): boolean {
  if (now - open.since >= GUARD_DOWN_WINDOW_MS) {
    open.since = now;
    open.sent = 0;
  }
  if (open.sent >= GUARD_DOWN_CAP) return false;
  if (open.sent === 0) console.log(JSON.stringify({ evt: "spend", kind: "guard_down" }));
  open.sent++;
  return true;
}

function switchAllows(deps: Pick<MailDeps, "account" | "emailSwitch">, to: string): boolean {
  if (deps.emailSwitch === "off") return false;
  if (deps.emailSwitch === "on") return true;
  const norm = normalizeEmail(to);
  return !!norm && deps.account.adminEmails.has(norm);
}

async function admit(deps: MailDeps, message: Message, now: number): Promise<boolean> {
  if (normalizeEmail(message.to) === null || !switchAllows(deps, message.to)) return false;
  let guardDown = false;
  const takes = message.codeScope === undefined ? [] : [() => deps.spend.take("email_code", 1, message.codeScope)];
  for (const take of [...takes, () => deps.spend.take("email", 1)]) {
    const r = await take();
    if (r.ok) continue;
    if (r.reason !== "unavailable") return false;
    guardDown = true;
  }
  return !guardDown || guardDownSlot(now);
}

export interface DevMail {
  to: string;
  subject: string;
  text: string;
  at: number;
}

/** Local only (DEV_MAILBOX, which config refuses on a deployed origin): the newest mail, oldest dropped first. */
const DEV_MAILBOX_CAP = 50;
const devMailbox: DevMail[] = [];

export const readDevMailbox = (to?: string): DevMail[] =>
  devMailbox.filter((m) => to === undefined || m.to === to).map((m) => ({ ...m }));

export const clearDevMailbox = (): void => {
  devMailbox.length = 0;
};

const log = (fields: Record<string, string>) => console.log(JSON.stringify(fields));

/** Errors are logged by code only, never with the address. A suppressed recipient is the unknown-address case. */
async function deliver(account: MailDeps["account"], sender: Sender | undefined, m: Message, now: number) {
  if (account.devMailbox) {
    devMailbox.push({ to: m.to, subject: m.subject, text: m.text, at: now });
    if (devMailbox.length > DEV_MAILBOX_CAP) devMailbox.shift();
    return;
  }
  if (!sender) return log({ evt: "email", kind: "no_binding" });
  try {
    await sender.send({ to: m.to, from: account.emailFrom, subject: m.subject, text: m.text, html: m.html });
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "E_RECIPIENT_SUPPRESSED") return log({ evt: "email_suppressed" });
    log({ evt: "email", kind: "send_failed", code: typeof code === "string" ? code : "error" });
  }
}

/**
 * TRANSITIONAL(a-4): the code and invite routes are the first callers.
 *
 * Queues one email. Resolves to whether it was admitted (a valid address, the switch and spend), never to whether it
 * was delivered, so a caller may await it (an invite's `mailed`) or ignore it (a code request, which must not wait).
 * A refusal sends nothing and is not an error.
 */
export function mail(deps: MailDeps, ctx: WaitUntil, message: Message, now: number = Date.now()): Promise<boolean> {
  const admitted = admit(deps, message, now).catch(() => {
    log({ evt: "email", kind: "admit_failed" });
    return false;
  });
  ctx.waitUntil(admitted.then((ok) => (ok ? deliver(deps.account, deps.sender, message, now) : undefined)));
  return admitted;
}

/** One alert key mails at most once in this window. */
export const ALERT_WINDOW_MS = 86_400_000;

/** The kind and the rule name an alert: its `setting` row key, letters, digits and `_` only. */
const alertKey = (message: { kind: string } & Record<string, unknown>): string =>
  `alert.${[message.kind, typeof message.rule === "string" ? message.rule : ""]
    .map((part) => part.replace(/[^A-Za-z0-9_]/g, ""))
    .join(".")}`;

/**
 * Claims the key's window in one guarded UPSERT (the row's `updated_at` is the last send), so overlapping runs and
 * retries send one mail per key per window. False when the window is already taken.
 */
async function claimAlert(db: Db, key: string, now: number): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?2, 'breaker')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE setting.updated_at <= ?3`,
    )
    .bind(key, now, now - ALERT_WINDOW_MS)
    .run();
  return res.meta.changes === 1;
}

export interface NotifyDeps extends Pick<MailDeps, "account" | "sender" | "emailSwitch"> {
  db: Db;
}

/**
 * TRANSITIONAL(G): the spend cron passes this as runSpendBreaker's `notify` once the spend guard is in this tree.
 *
 * The spend breaker's `notify`: one mail to each ADMIN_EMAILS address, never to anyone else, under the `email` switch,
 * at most once per alert key per window. It skips the spend takes, which would call back into the guard the breaker is
 * acting on. The breaker already runs inside the cron's waitUntil.
 */
export const breakerNotify =
  (deps: NotifyDeps, config: TemplateConfig, now: () => number = Date.now) =>
  async (message: { kind: string } & Record<string, unknown>): Promise<void> => {
    const to = [...deps.account.adminEmails].filter((address) => switchAllows(deps, address));
    if (to.length === 0 || !(await claimAlert(deps.db, alertKey(message), now()))) return;
    const alert = spendAlert(message, config);
    for (const address of to) await deliver(deps.account, deps.sender, { to: address, ...alert }, now());
  };
