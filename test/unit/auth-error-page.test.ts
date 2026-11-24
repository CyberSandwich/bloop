import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callbackErrorPage, WORDS } from "../../src/worker/auth/error-page.ts";
import type { SignInError } from "../../src/worker/auth/oauth.ts";
import { policyOf } from "../../src/worker/headers.ts";

const FAILURES = Object.keys(WORDS) as SignInError[];

describe("the /auth/callback error page", () => {
  it.each(FAILURES)("%s is an HTML page under the app policy, never problem+json", async (failure) => {
    const res = callbackErrorPage(failure);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(policyOf(res, "api")).toBe("app");
    const html = await res.text();
    expect(html).toContain(`<h1>${WORDS[failure].title}</h1>`);
    expect(html).not.toContain("about:blank");
    expect(html).not.toContain("<script");
  });

  it("keeps the status each failure had as problem+json", () => {
    expect(FAILURES.map((f) => [f, callbackErrorPage(f).status])).toEqual([
      ["state", 400],
      ["issuer", 401],
      ["exchange", 502],
      ["consent_declined", 403],
      ["admin_consent_required", 403],
    ]);
  });

  it("offers Enter the Code except where only IT can help", async () => {
    expect(await callbackErrorPage("consent_declined").text()).toContain('href="/code"');
    expect(await callbackErrorPage("admin_consent_required").text()).not.toContain("<a ");
  });

  it("follows the voice rules and never-say list", () => {
    const never = readFileSync(new URL("../../tools/never-say.txt", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"));
    const text = Object.values(WORDS)
      .flatMap((w) => [w.title, w.body])
      .join(" ");
    expect(text).not.toMatch(/[–—!]/);
    for (const phrase of never) expect(text.toLowerCase(), phrase).not.toContain(phrase);
  });
});
