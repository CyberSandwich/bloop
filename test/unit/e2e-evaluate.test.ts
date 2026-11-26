// Playwright's evaluate treats a string as an expression to run, not a function to call, so a string holding a bare
// function (`(el) => ...`) returns undefined at run time, and the type check never sees inside the string. An
// expression (`location.hash`) or an invoked function (`(() => ...)()`) is fine; a function is passed as a callback.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const E2E_DIR = "test/e2e";
const BARE_FUNCTION = /\.evaluate(?:Handle)?\(\s*[`'"]\s*(?:async\s+)?(?:function\b|\w+\s*=>|\([^()]*\)\s*=>)/g;

describe("e2e: evaluate is never given a string that is a function left uncalled", () => {
  it("catches a bare function in a string, and lets an expression or an invoked function through", () => {
    for (const bad of [
      "row.evaluate(`(el) => el`)",
      'page.evaluateHandle(\n  "() => 1")',
      "x.evaluate('el => el.id')",
      'x.evaluate("async (el) => 1")',
      'x.evaluate("function () { return 1 }")',
    ])
      expect(bad.match(BARE_FUNCTION), bad).not.toBeNull();
    for (const ok of [
      'page.evaluate("location.hash")',
      "page.evaluate(`(() => { return 1; })()`)",
      "page.evaluate(`(() => [...document.querySelectorAll('a')])()`)",
      "row.evaluate((el) => el)",
    ])
      expect(ok.match(BARE_FUNCTION), ok).toBeNull();
  });

  it("no e2e file passes one", () => {
    const files = (readdirSync(E2E_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const hits = readFileSync(join(E2E_DIR, file), "utf8").match(BARE_FUNCTION) ?? [];
      expect(hits, `${file} passes a function in a string to evaluate`).toEqual([]);
    }
  });
});
