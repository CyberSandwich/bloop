// Every email bloop sends (ADR 0021): pure functions from values to {subject, text, html}. Subjects are fixed
// text plus at most a date or a meter kind, never a code or anything a user typed. Each value passes through `oneLine`,
// and the HTML escapes it, so a file name cannot add a header line or markup. Links point only at the configured origin.
import type { Alert, DigestMessage } from "../spend/breaker.ts";
import { isSwitchName } from "../spend/switches.ts";

export interface Email {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateConfig {
  /** PUBLIC_ORIGIN: the only host a link may name. */
  origin: string;
  codeTtlSeconds: number;
}

const MAX_VALUE_CHARS = 120;

/**
 * CR, LF, every other control character and every format character (bidi overrides, zero-width spaces) dropped, so a
 * value can neither add a line nor reorder the text around it.
 */
export const stripControls = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");

/** One line of at most 120 code points (`stripControls`), cut between code points so no surrogate pair splits. */
export function oneLine(value: string): string {
  return [...stripControls(value)].slice(0, MAX_VALUE_CHARS).join("");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The owner's market: "2 Dec", and times in UK time.
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
const TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
export const formatDay = (ms: number): string => DAY.format(ms);
const formatTime = (ms: number): string => TIME.format(ms);

/** A paragraph: plain text, or a code line whose code is its own node in the HTML. */
type Para = string | { code: string; after: string };

const host = (c: Pick<TemplateConfig, "origin">) => new URL(c.origin).host;
const minutes = (c: TemplateConfig) => Math.round(c.codeTtlSeconds / 60);

function render(c: Pick<TemplateConfig, "origin">, subject: string, paras: Para[]): Email {
  const all: Para[] = [...paras, `bloop · ${host(c)}. Reply to this email to reach a person.`];
  const text = all.map((p) => (typeof p === "string" ? p : `${p.code}${p.after}`)).join("\n\n");
  const origin = escapeHtml(c.origin);
  const link = (escaped: string) =>
    escaped.replace(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/[^\\s<]*)?`, "g"), (url) => {
      const href = url.replace(/[.,]$/, "");
      return `<a href="${href}">${href}</a>${url.slice(href.length)}`;
    });
  const body = all
    .map((p) =>
      typeof p === "string"
        ? `<p>${link(escapeHtml(p))}</p>`
        : `<p><span style="font-size:28px;font-weight:600;letter-spacing:4px">${escapeHtml(p.code)}</span>${escapeHtml(p.after)}</p>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">${body}</body></html>`;
  return { subject, text, html };
}

const preheader = (c: TemplateConfig) => `Your bloop code is inside. Enter it only at ${host(c)}.`;
const ignoreLine = "Didn't ask for it? You can ignore this email. Nobody can sign in without the code.";

// TRANSITIONAL(a-4): the code request sends it.
/** 1 and 2: a sign-in or invite code. Line 1 is the preheader, line 2 the code unspaced, for mail apps' code detection. */
export const signinCode = (v: { code: string }, c: TemplateConfig): Email =>
  render(c, "Your bloop Sign-In Code", [
    preheader(c),
    { code: oneLine(v.code), after: ` is your code. It works for ${minutes(c)} minutes.` },
    ignoreLine,
  ]);

// TRANSITIONAL(a-4): the reauth code request sends it.
export const reauthCode = (v: { code: string }, c: TemplateConfig): Email =>
  render(c, "Your bloop Confirmation Code", [
    preheader(c),
    { code: oneLine(v.code), after: ` is your code to confirm it's you. It works for ${minutes(c)} minutes.` },
    `Didn't ask for it? Someone may be using your account. Sign in at ${host(c)}/account and choose Sign Out Everywhere.`,
  ]);

// TRANSITIONAL(a-7): email change sends it.
/** To the new address. */
export const emailChangeCode = (v: { code: string }, c: TemplateConfig): Email =>
  render(c, "Confirm Your New Email for bloop", [
    preheader(c),
    {
      code: oneLine(v.code),
      after: ` is your code to move your bloop account to this address. It works for ${minutes(c)} minutes.`,
    },
    ignoreLine,
  ]);

// TRANSITIONAL(a-7): email change sends it.
/** To the old address, with the revert link. */
export const emailChanged = (v: { newMasked: string; token: string; revertDays: number }, c: TemplateConfig): Email =>
  render(c, "Your bloop Email Was Changed", [
    `Your bloop account now signs in with ${oneLine(v.newMasked)}.`,
    "Was this you? Then there's nothing to do.",
    `If it wasn't, change it back within ${v.revertDays} days: ${c.origin}/signin#revert=${oneLine(v.token)}`,
    "Changing it back signs out every device.",
  ]);

// TRANSITIONAL(a-7): the revert sends it.
export const emailBack = (_v: Record<string, never>, c: TemplateConfig): Email =>
  render(c, "Your bloop Email Is Back", [
    `Your bloop account signs in with this address again, and every device was signed out. Sign in at ${host(c)}/signin.`,
  ]);

// TRANSITIONAL(a-4): invite create and resend send it.
export const invite = (v: { email: string; token: string; expiresAt: number }, c: TemplateConfig): Email =>
  render(c, "You're Invited to bloop", [
    `Early access to bloop for ${oneLine(v.email)}.`,
    "bloop puts your files on the room screen from your phone. The screen never gets your account.",
    `Accept Invite: ${c.origin}/invite#t=${oneLine(v.token)}`,
    `The invite works until ${formatDay(v.expiresAt)}. It's for this address only, so your sign-in code comes here too.`,
  ]);

/** TRANSITIONAL(a-5): passkey registration sends it. No passkey name: the mail carries nothing the member typed. */
export const passkeyAdded = (v: { label: string; at: number }, c: TemplateConfig): Email =>
  render(c, "A Passkey Was Added to Your bloop Account", [
    `A passkey was added to your bloop account on ${oneLine(v.label)} at ${formatTime(v.at)}.`,
    `Was this you? Then there's nothing to do. If it wasn't, sign in at ${host(c)}/account, remove it, and choose Sign Out Everywhere.`,
  ]);

// TRANSITIONAL(a-7): DELETE /api/me sends it.
export const deletionScheduled = (v: { deleteAfter: number }, c: TemplateConfig): Email =>
  render(c, `Your bloop Account Will Be Deleted on ${formatDay(v.deleteAfter)}`, [
    `You asked to delete your bloop account. Your files, library and history are deleted on ${formatDay(v.deleteAfter)}.`,
    `Changed your mind? Sign in at ${host(c)}/signin before then and choose Cancel Deletion.`,
  ]);

// TRANSITIONAL(a-7): the retention job's warning sends it.
export const inactivityWarning = (v: { months: number; deleteAfter: number }, c: TemplateConfig): Email =>
  render(c, `Your bloop Account Will Be Deleted on ${formatDay(v.deleteAfter)}`, [
    `Your bloop account hasn't been used for ${v.months} months, so it and its files are deleted on ${formatDay(v.deleteAfter)}.`,
    `To keep it, sign in at ${host(c)}/signin before then.`,
  ]);

// TRANSITIONAL(a-7): the account purge sends it.
export const accountDeleted = (v: { deletedAt: number; backupDays: number }, c: TemplateConfig): Email =>
  render(c, "Your bloop Account Was Deleted", [
    `Your bloop account and its files were deleted on ${formatDay(v.deletedAt)}. Backup copies are gone ${v.backupDays} days after that.`,
    "Thank you for trying bloop.",
  ]);

// TRANSITIONAL(a-9): a report sends it.
/** To the admin: no detail and no file name, so the alert holds nothing the reporter typed. */
export const newReport = (v: { category: string; at: number }, c: TemplateConfig): Email =>
  render(c, "New bloop Report", [
    `A ${oneLine(v.category)} report arrived at ${formatTime(v.at)}. Open ${c.origin}/admin#reports.`,
  ]);

const numberLines = (v: Record<string, unknown>): string[] =>
  Object.entries(v).flatMap(([key, value]) =>
    typeof value === "number" && Number.isFinite(value)
      ? [`${oneLine(key).replace(/[^A-Za-z0-9_]/g, "")}: ${value}`]
      : [],
  );

/** An identifier from the breaker: lowercase letters, digits and `_` only, whatever the field held. */
const ident = (value: unknown): string => (typeof value === "string" ? oneLine(value).replace(/[^a-z0-9_]/g, "") : "");

/**
 * To the admin, from the spend breaker: the kind, the rule, each switch it flipped (a known switch name only) with its
 * new value, and the numbers under `readings`; any other field is dropped.
 */
export const spendAlert = (
  v: Pick<Alert, "kind" | "rule" | "switch" | "value" | "flips" | "readings">,
  c: Pick<TemplateConfig, "origin">,
): Email => {
  const kind = ident(v.kind);
  const rule = ident(v.rule);
  const flips = [...(v.flips ?? []), ...(v.switch ? [{ switch: v.switch, value: v.value ?? "" }] : [])]
    .filter((f) => isSwitchName(f.switch))
    .map((f) => `${f.switch} set to ${ident(f.value)}`);
  const switches = [...new Set(flips)];
  return render(c, `bloop Spend: ${kind}`, [
    `Spend alert: ${kind}.`,
    ...(rule ? [`Rule: ${rule}.`] : []),
    ...(switches.length > 0 ? [`Switches: ${switches.join(", ")}.`] : []),
    ...numberLines(v.readings),
  ]);
};

/** To the admin, the breaker's Monday digest: spend/report.ts builds its text from numbers and fixed labels only. */
export const spendDigest = (v: Pick<DigestMessage, "subject" | "text">, c: Pick<TemplateConfig, "origin">): Email =>
  render(
    c,
    oneLine(v.subject),
    v.text.split("\n").filter((line) => line.trim() !== ""),
  );
