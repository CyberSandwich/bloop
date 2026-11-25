// The prefilled support mail (shared/support.js, design.md section 3): one helper for /a and the error page.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORT } from "../../public/js/shared/errors.js";
import { supportMail } from "../../public/js/shared/support.js";
import { callbackErrorPage } from "../../src/worker/auth/error-page.ts";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Safari/604.1";
const FACTS = { Page: "/a", State: "service_down", Error: "internal", Time: "2026-11-25T10:00:00.000Z", Browser: UA };

/** The mail's parts, decoded as a mail app reads them. */
const parse = (href: string) => {
  const url = new URL(href);
  return { to: url.pathname, subject: url.searchParams.get("subject"), body: url.searchParams.get("body") ?? "" };
};

/** A sid or pid (`<22-char ref>.<43-char secret>`), a pairing code (6 or 7 of the code alphabet), a bearer token. */
const CREDENTIALS = [/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/, /\b[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6,7}\b/, /Bearer/i];

describe("the support mail", () => {
  it("goes to the one address, with the subject and blank prompts first, then one fact a line", () => {
    const mail = parse(supportMail("bloop isn't responding", FACTS));
    expect(mail.to).toBe(SUPPORT);
    expect(mail.subject).toBe("bloop isn't responding");
    expect(mail.body).toBe(
      [
        "What were you trying to do?",
        "",
        "",
        "What happened?",
        "",
        "",
        "Page: /a",
        "State: service_down",
        "Error: internal",
        "Time: 2026-11-25T10:00:00.000Z",
        `Browser: ${UA}`,
      ].join("\n"),
    );
  });

  it("encodes what a mailto would otherwise split on: & ? # + = and spaces never end a field early", () => {
    const href = supportMail("a&b?c#d+e=f g", { ...FACTS, Browser: "x&body=y" });
    expect(href).not.toMatch(/[ #]/);
    expect(href.split("&")).toHaveLength(2);
    const mail = parse(href);
    expect(mail.subject).toBe("a&b?c#d+e=f g");
    expect(mail.body.endsWith("Browser: x&body=y")).toBe(true);
  });

  it("leaves out a fact with no value, so no line ends in a bare colon", () => {
    const body = parse(supportMail("x", { ...FACTS, Error: null, Browser: "" })).body;
    expect(body.endsWith("Time: 2026-11-25T10:00:00.000Z")).toBe(true);
    expect(body).not.toMatch(/Error|Browser|: *$/m);
  });

  it("carries no credential: no sid, pid, pairing code or token, whatever the page's state", () => {
    for (const state of ["service_down", "error", "offline"]) {
      const body = parse(supportMail("x", { ...FACTS, State: state })).body;
      for (const pattern of CREDENTIALS) expect(body, String(pattern)).not.toMatch(pattern);
    }
  });

  it("the phone builds it from the path, the state key, the code, the time and the browser alone", () => {
    const phone = readFileSync(new URL("../../public/js/phone.js", import.meta.url), "utf8");
    const call = phone.slice(phone.indexOf("supportMail("), phone.indexOf("}),", phone.indexOf("supportMail(")));
    expect(call).toContain('Page: "/a"');
    for (const leak of ["pid", "sid", "location", "file", "room", "code:"]) expect(call, leak).not.toContain(leak);
  });

  it("the error page links the address to the same mail, with no browser fact and nothing from the request", async () => {
    const html = await callbackErrorPage("exchange", new Date("2026-11-25T10:00:00Z")).text();
    const href = /<a href="(mailto:[^"]+)">hi@bloop\.here<\/a>/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const mail = parse(href);
    expect(mail.subject).toBe("Couldn't sign you in.");
    expect(mail.body).toContain("Page: /auth/callback\nState: exchange\nError: source_unavailable");
    expect(mail.body.endsWith("Time: 2026-11-25T10:00:00.000Z")).toBe(true);
    expect(mail.body).not.toContain("Browser");
    for (const pattern of CREDENTIALS) expect(mail.body, String(pattern)).not.toMatch(pattern);
    expect(html).toContain("Scan the code on the screen to try again, or email");
    expect(html).not.toMatch(/sign in to/i);
  });
});
