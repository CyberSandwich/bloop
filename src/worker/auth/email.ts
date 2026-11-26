// The one way mail leaves bloop (ADR 0021): the `email` switch, then the spend takes, then the Email Service binding,
// all inside ctx.waitUntil so no response waits on mail or reveals by its timing whether mail was sent (AUTH-10).
import { z } from "zod";
import { type AccountConfig, accountVars } from "../config/account.ts";
import { coreVars, isLocalOrigin } from "../config/core.ts";
import { readSettings } from "../settings.ts";
import { deliveryClaims, logNotify, type Notify } from "../spend/breaker.ts";
import type { Spend } from "../spend/client.ts";
import { effectiveAll } from "../spend/switches.ts";
import { emailSet, normalizeEmail } from "./email-norm.ts";
import { type Email, spendAlert, spendDigest, type TemplateConfig } from "./templates.ts";

/** A rendered email and its one recipient. `codeScope` (the IP hash) marks a code request, which also takes `email_code`. */
export interface Message extends Email {
  to: string;
  codeScope?: string;
}

/** The `email` switch (docs/spend.md): admin_only mails ADMIN_EMAILS recipients only. */
export type EmailSwitch = "on" | "admin_only" | "off";

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
  /** The email meters fail open, within a per-isolate cap, while their guard is unreachable (spend/client.ts). */
  spend: Pick<Spend, "take">;
  emailSwitch: EmailSwitch;
}

function switchAllows(deps: Pick<MailDeps, "account" | "emailSwitch">, to: string): boolean {
  if (deps.emailSwitch === "off") return false;
  if (deps.emailSwitch === "on") return true;
  const norm = normalizeEmail(to);
  return !!norm && deps.account.adminEmails.has(norm);
}

async function admit(deps: MailDeps, message: Message): Promise<boolean> {
  if (normalizeEmail(message.to) === null || !switchAllows(deps, message.to)) return false;
  if (message.codeScope !== undefined && !(await deps.spend.take("email_code", 1, message.codeScope)).ok) return false;
  return (await deps.spend.take("email", 1)).ok;
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

/**
 * True when the message was handed over. Never throws: errors are logged by code only, never with the address, and a
 * suppressed recipient is the unknown-address case.
 */
async function deliver(account: MailDeps["account"], sender: Sender | undefined, m: Message, now: number) {
  if (account.devMailbox) {
    devMailbox.push({ to: m.to, subject: m.subject, text: m.text, at: now });
    if (devMailbox.length > DEV_MAILBOX_CAP) devMailbox.shift();
    return true;
  }
  if (!sender) {
    log({ evt: "email", kind: "no_binding" });
    return false;
  }
  try {
    await sender.send({ to: m.to, from: account.emailFrom, subject: m.subject, text: m.text, html: m.html });
    return true;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "E_RECIPIENT_SUPPRESSED") log({ evt: "email_suppressed" });
    else log({ evt: "email", kind: "send_failed", code: typeof code === "string" ? code : "error" });
    return false;
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
  const admitted = admit(deps, message).catch(() => {
    log({ evt: "email", kind: "admit_failed" });
    return false;
  });
  ctx.waitUntil(admitted.then((ok) => (ok ? deliver(deps.account, deps.sender, message, now) : undefined)));
  return admitted;
}

/**
 * The spend breaker's mail: one message to each ADMIN_EMAILS address, never to anyone else, under the `email` switch.
 * It skips the spend takes, which would call back into the guard the breaker is acting on. The breaker sends each
 * alert key once a UTC day (`alertOnce`); throwing when no address took the message releases that claim, so the next
 * run tries again. Nothing to send (the switch, no admin address) is not a failure.
 */
export const breakerNotify =
  (
    deps: Pick<MailDeps, "account" | "sender" | "emailSwitch">,
    config: Pick<TemplateConfig, "origin">,
  ): ((message: Parameters<Notify>[0]) => Promise<void>) =>
  async (message) => {
    const to = [...deps.account.adminEmails].filter((address) => switchAllows(deps, address));
    if (to.length === 0) return;
    const email = message.kind === "digest" ? spendDigest(message, config) : spendAlert(message, config);
    let delivered = 0;
    for (const address of to)
      if (await deliver(deps.account, deps.sender, { to: address, ...email }, Date.now())) delivered++;
    if (delivered === 0) throw new Error("alert_undelivered");
  };

/** The vars the breaker's mail needs, parsed alone: the config_invalid alert still mails when another var broke. */
const alertVars = z.object({
  PUBLIC_ORIGIN: coreVars.PUBLIC_ORIGIN,
  EMAIL_FROM: accountVars.EMAIL_FROM,
  ADMIN_EMAILS: accountVars.ADMIN_EMAILS,
  DEV_MAILBOX: accountVars.DEV_MAILBOX,
});

/** The guard's once-a-UTC-day claim (`alertOnce`). An unreachable guard counts as claimed, so the alert still goes out. */
export type Claim = (key: string) => Promise<boolean>;

/**
 * The five-minute breaker's `notify` (cron-jobs.ts), valid config or not. The breaker calls it again on every run until
 * it resolves, so the structured log line (an Observability alert matches it) has its own claim and is written once a
 * day, and the mail has `ALERT_MAIL_TRIES` claims (`deliveryClaims`, which a breaker reset releases): a failed send
 * throws and is retried next run, at most that often.
 * The `email` switch is read fresh. An invalid alert var leaves the log line only.
 */
export const cronNotify =
  (env: { DB: unknown; EMAIL?: Sender }, claim: Claim): Notify =>
  async (message, key) => {
    const claimed = (claimKey: string) => claim(claimKey).catch(() => true);
    const [logClaim, ...mailClaims] = deliveryClaims(key);
    if (await claimed(logClaim ?? "")) await logNotify(message, key);
    const parsed = alertVars.safeParse(env);
    if (!parsed.success) return;
    const v = parsed.data;
    const vars = env as unknown as Readonly<Record<string, unknown>>;
    const emailSwitch = effectiveAll(vars, await readSettings(env, { fresh: true })).email as EmailSwitch;
    const account = {
      emailFrom: v.EMAIL_FROM,
      adminEmails: emailSet(v.ADMIN_EMAILS),
      // Config refuses DEV_MAILBOX on a deployed origin; this parse does not, so the rule is repeated here.
      devMailbox: v.DEV_MAILBOX === "1" && isLocalOrigin(v.PUBLIC_ORIGIN),
    };
    let tried = false;
    for (const mailClaim of mailClaims) {
      tried = await claimed(mailClaim);
      if (tried) break;
    }
    if (!tried) return;
    await breakerNotify(
      { account, sender: env.EMAIL, emailSwitch },
      { origin: new URL(v.PUBLIC_ORIGIN).origin },
    )(message);
  };
