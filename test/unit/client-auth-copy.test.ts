// The sign-in and invite strings (public/js/auth/copy.js, copy-signin.js, copy-invite.js): the voice rules, the UX string tables, and the first paint.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH, clock } from "../../public/js/auth/copy.js";
import { INVITE } from "../../public/js/auth/copy-invite.js";
import { SIGNIN } from "../../public/js/auth/copy-signin.js";
import { NEVER_SAY } from "./never-say.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Every string in the object; a function is called with the example the UX tables use. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [value(value === AUTH.code.tooManyCodes ? 900 : 24_000)];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
const ALL = strings([AUTH, SIGNIN, INVITE]).filter((s) => !["home", "signin", "retry"].includes(s));
// A time or a count is one token, as a name is (design.md section 3).
const words = (text: string) => text.split(/\s+/).filter((w) => w && !/\d/.test(w)).length;
const SMALL = new Set("a an the and but or nor for as at by in of on to with bloop".split(" "));
const titles = [
  SIGNIN.title,
  AUTH.code.title,
  INVITE.title,
  INVITE.signedInAs,
  INVITE.signedInAs.replace("{masked}", "a**@other.example"),
  ...Object.values(INVITE.dead).map((d) => d.title),
];
const labels = [
  SIGNIN.email,
  AUTH.code.label,
  SIGNIN.send,
  AUTH.code.other,
  AUTH.code.resend,
  AUTH.code.resendIn(24_000),
  INVITE.accept,
  INVITE.signOut,
  INVITE.library,
  INVITE.home,
  INVITE.signIn,
  INVITE.retry,
  SIGNIN.retry,
];

describe("sign-in copy", () => {
  it("has no never-say phrase", () => {
    expect(ALL.length).toBeGreaterThan(40);
    for (const text of ALL) for (const phrase of NEVER_SAY) expect(text.toLowerCase(), text).not.toContain(phrase);
  });

  it("has no em or en dash, exclamation mark or emoji, and never says we, session, token or something went wrong", () => {
    for (const text of ALL) {
      expect(text).not.toMatch(/[–—!]/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, text).not.toMatch(/\b(oops|uh-oh|we|our|session|token|tenant|beta)\b/i);
      expect(text.toLowerCase(), text).not.toContain("something went wrong");
    }
  });

  it("titles and labels are Title Case with no period, at most 5 words (an address counting as one)", () => {
    for (const text of [...titles, ...labels]) {
      expect(text, text).not.toMatch(/\.$/);
      expect(words(text), text).toBeLessThanOrEqual(5);
      expect(
        text
          .split(" ")
          .filter((w: string, i: number) => i > 0 && /^[a-z]/.test(w) && !SMALL.has(w) && !w.includes("@")),
        text,
      ).toEqual([]);
    }
  });

  it("lines are sentences of at most 20 words, ending in a period", () => {
    const lines = ALL.filter((s) => ![...titles, ...labels].includes(s) && s !== SIGNIN.checking);
    for (const text of lines) {
      expect(text, text).toMatch(/[.?]$/);
      for (const sentence of text.split(/(?<=\.) /)) expect(words(sentence), sentence).toBeLessThanOrEqual(20);
    }
  });

  it("every string is in the UX string tables (docs/ux/signin.md, docs/ux/states.md)", () => {
    const ux = read("docs/ux/signin.md") + read("docs/ux/states.md");
    for (const text of ALL) expect(ux, text).toContain(text);
  });

  it("the countdown is m:ss, rounded up, never 0:00 while it runs", () => {
    expect([clock(30_000), clock(24_000), clock(23_001), clock(1), clock(0), clock(900_000)]).toEqual([
      "0:30",
      "0:24",
      "0:24",
      "0:01",
      "0:00",
      "15:00",
    ]);
  });

  it("the wait over the bucket is the server's, in whole minutes, singular for one", () => {
    expect(AUTH.code.tooManyCodes(900)).toBe("Too many codes for now. Try again in 15 minutes.");
    expect(AUTH.code.tooManyCodes(61)).toBe("Too many codes for now. Try again in 2 minutes.");
    expect(AUTH.code.tooManyCodes(1)).toBe("Too many codes for now. Try again in 1 minute.");
  });
});

describe("the pages' first paint says what the copy modules say", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

  it("/signin", () => {
    const page = text(read("public/signin.html"));
    for (const s of [
      SIGNIN.title,
      SIGNIN.lead,
      SIGNIN.email,
      SIGNIN.send,
      SIGNIN.waitlist,
      AUTH.code.label,
      AUTH.code.other,
      AUTH.code.resend,
      SIGNIN.retry,
    ])
      expect(page, s).toContain(s);
  });

  it("/invite", () => {
    const page = text(read("public/invite.html"));
    for (const s of [
      INVITE.title,
      INVITE.about,
      INVITE.adult,
      INVITE.accept,
      INVITE.signOut,
      INVITE.library,
      INVITE.home,
      INVITE.signIn,
      INVITE.retry,
      AUTH.code.label,
      AUTH.code.resend,
    ])
      expect(page, s).toContain(s);
  });
});
