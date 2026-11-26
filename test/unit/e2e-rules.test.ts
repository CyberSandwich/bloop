// Rules for the e2e specs that a reading can hold (they run in CI only).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../e2e/", import.meta.url);
const specs = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, text: readFileSync(new URL(f, dir), "utf8") }));

describe("e2e specs", () => {
  it("never claim no toast with a retrying toHaveCount(0): a toast leaves by itself, so it passes either way", () => {
    // A tap that dismisses one waits with toBeHidden; "none came" is expectNoToast, one read.
    const retrying = /(toast\b[^;\n]*|getByRole\("(alert|status)"\)|\balert)\)\.toHaveCount\(0\)/;
    for (const { f, text } of specs) {
      const bad = text.split("\n").filter((line) => retrying.test(line) && !line.trim().startsWith("/"));
      expect(bad, f).toEqual([]);
    }
  });

  it("never go back or forward straight after a click or tap: wait for the page it opened first", () => {
    // A click returns before its navigation commits; history read mid-swap fails "not attached to an active page".
    const travel = /\.go(Back|Forward)\(/;
    for (const { f, text } of specs) {
      const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("/"));
      const bad = lines.filter((line, i) => travel.test(line) && /\.(click|tap)\(/.test(lines[i - 1] ?? ""));
      expect(bad, f).toEqual([]);
    }
  });

  it("never read the viewer pill's box straight off a locator: settledPill reads it in one frame, glides done", () => {
    // The pill moves when the stage lays out a new item and glides on a change of place; two boundingBox calls can
    // straddle that move, and one taken mid-glide is scaled.
    // A locator held in a variable or passed to a wrapper slips past this; review keeps those to settledPill.
    const direct = /locator\((["'`])#(controls|dots)\1\)\.boundingBox\(/;
    for (const { f, text } of specs) {
      const bad = text.split("\n").filter((line) => direct.test(line) && !line.trim().startsWith("/"));
      expect(bad, f).toEqual([]);
    }
  });

  it("settle a fixture page's route.fetch handlers before the test ends: unrouteAll waits for the one still in flight", () => {
    // A page the test navigates to asks for the routed file after the last assertion; the handler then dies with
    // "route.fetch: Test ended". Routes on a context-owned page (`phone.page`) are closed with their context.
    const fixtureRoute = /(?<![.\w])page\.route\(/g;
    for (const { f, text } of specs) {
      const fetching = [...text.matchAll(fixtureRoute)].some((m) => {
        const rest = text.slice(m.index, m.index + 400);
        const next = rest.indexOf(".route(", 8);
        return (next < 0 ? rest : rest.slice(0, next)).includes("route.fetch()");
      });
      if (fetching) expect(text, f).toContain('unrouteAll({ behavior: "wait" })');
    }
  });
});

// A one-shot read takes whatever is drawn at that instant, which may be before the state it meant has landed. Each
// rule names such a form; its fix is a wait on the state the page shows, never on time.
describe("e2e specs wait on the state the page shows, never read it once", () => {
  const code = (line: string) => !/^\s*(\/|\*)/.test(line);
  const offending = (text: string, test: (line: string, next: string, before: string[]) => boolean) => {
    const all = text.split("\n");
    return all.filter((line, i) => code(line) && test(line, all[i + 1] ?? "", all.slice(Math.max(0, i - 3), i)));
  };

  it("a list of texts is read only after a toHaveCount wait, at most three lines above", () => {
    for (const { f, text } of specs) {
      const bad = offending(
        text,
        (line, _next, before) =>
          /\.all(TextContents|InnerTexts)\(/.test(line) && !before.some((l) => l.includes(".toHaveCount(")),
      );
      expect(bad, f).toEqual([]);
    }
  });

  it("a code that must change is polled (expect.poll), not read once and compared", () => {
    for (const { f, text } of specs) expect(text, f).not.toMatch(/expect\(await typedCodeOf\([^)]*\)\)\.not\./);
  });

  it("the screen's number is read only through pairing.ts's shownMatch, which waits for two digits", () => {
    for (const { f, text } of specs) {
      if (f !== "pairing.ts") expect(text, f).not.toMatch(/"#match"\)\.(textContent|innerText)\(/);
    }
  });

  it("a typed code goes with Continue once enabled (enterCode), never with Enter straight after the fill", () => {
    // Before code.js has read the field, Enter submits nothing.
    for (const { f, text } of specs) {
      const bad = offending(text, (line, next) => /\.fill\(/.test(line) && /keyboard\.press\("Enter"\)/.test(next));
      expect(bad, f).toEqual([]);
    }
  });

  it("a choice is found through #pick, never by the group's name, which reads Approving once a number is tapped", () => {
    for (const { f, text } of specs) {
      expect(text, f).not.toMatch(
        /(\bgroup\([^)]*\)|getByRole\("group", \{ name: (PICK|LEGEND|"Tap|\/Tap)[^)]*\))\.getByRole\("button", \{ name/,
      );
    }
    const pairing = specs.find((s) => s.f === "pairing.ts")?.text ?? "";
    expect(pairing).toMatch(/export const choice = \(phone: Page, digits: string\) =>\s*phone\.locator\("#pick"\)/);
  });

  it("the drawn choices are button.choice: a.html's skeleton pills are .choice too, so a bare one counts them", () => {
    for (const { f, text } of specs) expect(text, f).not.toMatch(/#pick \.choice/);
  });
});
