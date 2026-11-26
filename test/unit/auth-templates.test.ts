import { describe, expect, it } from "vitest";
import {
  accountDeleted,
  deletionScheduled,
  type Email,
  emailBack,
  emailChangeCode,
  emailChanged,
  escapeHtml,
  formatDay,
  inactivityWarning,
  invite,
  newReport,
  oneLine,
  passkeyAdded,
  reauthCode,
  signinCode,
  spendAlert,
  spendDigest,
  type TemplateConfig,
} from "../../src/worker/auth/templates.ts";
import { NEVER_SAY } from "./never-say.ts";

const CONFIG: TemplateConfig = { origin: "https://bloop.here", codeTtlSeconds: 600 };
const CODE = "081207";
/** Stands in for anything a user typed: a name, a label, an address, a category. */
const USER = "Zq7user";
const AT = Date.UTC(2026, 11, 2, 14, 5);

const RENDERED: Record<string, Email> = {
  signinCode: signinCode({ code: CODE }, CONFIG),
  reauthCode: reauthCode({ code: CODE }, CONFIG),
  emailChangeCode: emailChangeCode({ code: CODE }, CONFIG),
  emailChanged: emailChanged({ newMasked: `${USER}@example.test`, token: "t".repeat(43), revertDays: 7 }, CONFIG),
  emailBack: emailBack({}, CONFIG),
  invite: invite({ email: `${USER}@example.test`, token: "t".repeat(43), expiresAt: AT }, CONFIG),
  passkeyAdded: passkeyAdded({ label: USER, at: AT }, CONFIG),
  deletionScheduled: deletionScheduled({ deleteAfter: AT }, CONFIG),
  inactivityWarning: inactivityWarning({ months: 12, deleteAfter: AT }, CONFIG),
  accountDeleted: accountDeleted({ deletedAt: AT, backupDays: 30 }, CONFIG),
  newReport: newReport({ category: USER, at: AT }, CONFIG),
  spendAlert: spendAlert({ kind: "trip", readings: { spentUsd: 12, note: USER as never } }, CONFIG),
  spendDigest: spendDigest({ subject: "bloop spend digest 2026-W49", text: "Month to date: $1.00." }, CONFIG),
};
const CODE_TEMPLATES = ["signinCode", "reauthCode", "emailChangeCode"];

/** The subject rule every template must pass: no code-shaped run and nothing a user typed. */
const subjectLeaks = (email: Email): boolean => /\d{6}/.test(email.subject) || email.subject.includes(USER);

describe("templates", () => {
  it("templates: no subject holds 6 digits or any user text", () => {
    for (const [name, email] of Object.entries(RENDERED)) expect(subjectLeaks(email), name).toBe(false);
  });

  it("templates (fail-first): a template that put {name} in its subject is caught", () => {
    const leaky = (v: { name: string; label: string; at: number }, c: TemplateConfig): Email => ({
      ...passkeyAdded({ label: v.label, at: v.at }, c),
      subject: `Passkey ${v.name} Added`,
    });
    expect(subjectLeaks(leaky({ name: USER, label: "x", at: AT }, CONFIG))).toBe(true);
  });

  it("templates: line 1 of a code email has no digit run and line 2 holds the code unspaced", () => {
    for (const name of CODE_TEMPLATES) {
      const lines = (RENDERED[name] as Email).text.split("\n\n");
      expect(lines[0], name).toBe("Your bloop code is inside. Enter it only at bloop.here.");
      expect(lines[0], name).not.toMatch(/\d/);
      expect(lines[1]?.startsWith(`${CODE} is your code`), name).toBe(true);
      expect(lines[1], name).toContain("10 minutes");
      expect((RENDERED[name] as Email).html).toContain(`letter-spacing:4px">${CODE}</span>`);
    }
  });

  it("templates: a hostile file name or label comes out escaped and on one line", () => {
    const hostile = "<img src=x>\r\nBcc: victim@example.test";
    const email = passkeyAdded({ label: hostile, at: AT }, CONFIG);
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img src=x&gt;Bcc: victim@example.test");
    const line = email.text.split("\n\n")[0] ?? "";
    expect(line).toContain("<img src=x>Bcc: victim@example.test");
    expect(email.text.includes("\r")).toBe(false);
    expect(oneLine("a\u2028b\u0007c")).toBe("abc");
    // Bidi overrides and isolates, zero-width characters and the BOM are format characters: dropped.
    expect(oneLine("evil\u202Egnp.exe \u2066x\u2069 a\u200Bb\u200Dc\uFEFF")).toBe("evilgnp.exe x abc");
    expect(oneLine("x".repeat(500))).toHaveLength(120);
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });

  it("templates: links only go to PUBLIC_ORIGIN", () => {
    for (const [name, email] of Object.entries(RENDERED)) {
      for (const url of `${email.text} ${email.html}`.match(/https?:\/\/[^\s"<]+/g) ?? []) {
        expect(url.startsWith(`${CONFIG.origin}/`), `${name}: ${url}`).toBe(true);
      }
      for (const href of email.html.match(/href="[^"]*"/g) ?? []) {
        expect(href.startsWith(`href="${CONFIG.origin}/`), name).toBe(true);
      }
    }
    expect(RENDERED.invite?.html).toContain(`<a href="https://bloop.here/invite#t=${"t".repeat(43)}">`);
    // A lookalike host in user text never becomes a link to it.
    const lookalike = passkeyAdded({ label: "https://bloop.here.evil.example/x", at: AT }, CONFIG);
    expect(lookalike.html).not.toContain('href="https://bloop.here.evil');
  });

  it("templates: the output passes never-say, the dash rule and carries the footer", () => {
    for (const [name, email] of Object.entries(RENDERED)) {
      const all = `${email.subject}\n${email.text}\n${email.html}`;
      for (const phrase of NEVER_SAY) expect(all.toLowerCase(), `${name}: ${phrase}`).not.toContain(phrase);
      expect(all, name).not.toMatch(/[\u2013\u2014]/);
      expect(email.text.endsWith("bloop · bloop.here. Reply to this email to reach a person."), name).toBe(true);
    }
  });

  it("templates: dates use the en-GB day and short month, and durations come from config", () => {
    expect(formatDay(AT)).toBe("2 Dec");
    expect(RENDERED.deletionScheduled?.subject).toBe("Your bloop Account Will Be Deleted on 2 Dec");
    expect(signinCode({ code: CODE }, { ...CONFIG, codeTtlSeconds: 300 }).text).toContain("5 minutes");
  });

  it("templates: the spend alert keeps only the kind and the numbers under readings", () => {
    const email = RENDERED.spendAlert as Email;
    expect(email.subject).toBe("bloop Spend: trip");
    expect(email.text).toContain("spentUsd: 12");
    expect(email.text).not.toContain(USER);
    const alert = { kind: "trip", rule: USER, readings: { monthUsd: 41.5 } } as const;
    expect(spendAlert(alert, CONFIG).text).not.toContain(USER);
  });

  it("templates: the spend digest keeps its subject and its lines, one paragraph each", () => {
    const email = RENDERED.spendDigest as Email;
    expect(email.subject).toBe("bloop spend digest 2026-W49");
    expect(email.text.split("\n\n")[0]).toBe("Month to date: $1.00.");
  });

  it("templates: the passkey-added mail names no passkey, only that one was added, the device class and the time", () => {
    const email = RENDERED.passkeyAdded as Email;
    expect(email.text.split("\n\n")[0]).toBe(`A passkey was added to your bloop account on ${USER} at 2 Dec, 14:05.`);
  });
});
