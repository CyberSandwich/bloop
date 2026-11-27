// The phone's notes box and its floating panel are one family of glass-and-surface shapes, so they share one radius
// token, and the box ends above the panel instead of running under it (design.md section 7, Phone page). The browser
// side is in e2e (NOTES-01); this holds the rules that cannot drift apart in the source.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("NOTES-01 notes box: one radius with the panel, ending above it", () => {
  const notes = read("public/css/notes.css");
  const app = read("public/css/app.css");

  it("the box and the panel take the radius from one token", () => {
    expect(read("public/css/base.css")).toMatch(/--r-panel:\s*34px;/);
    expect(rule(notes, ".notes")).toContain("border-radius: var(--r-panel);");
    expect(rule(app, ".column > .actions")).toContain("border-radius: var(--r-panel);");
  });

  it("no stylesheet writes the panel's radius as 34px, except length.css (its owner moves it next)", () => {
    const sheets = readdirSync("public/css").filter((f) => f.endsWith(".css") && f !== "length.css");
    for (const sheet of sheets)
      expect(read(join("public/css", sheet)), `${sheet} writes 34px`).not.toMatch(/border-radius:\s*34px/);
  });

  it("the box has no negative margin and no padding that stands in for the panel", () => {
    const box = rule(notes, ".notes");
    expect(box).not.toMatch(/margin:[^;]*calc\(-/);
    expect(box).not.toContain("--panel");
    expect(box).toContain("margin: 0 0 16px;");
  });

  it("the reveal and the swap animate transform and opacity only, on the design's easing, with no fill mode", () => {
    const keyframes = [...notes.matchAll(/@keyframes (notes-[a-z]+) \{([\s\S]*?)\n {2}\}/g)];
    expect(keyframes.map((m) => m[1])).toEqual(["notes-in", "notes-swap"]);
    for (const [, name, body] of keyframes) {
      const props = [...(body ?? "").matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      expect(props.length, name).toBeGreaterThan(0);
      for (const prop of props) expect(["opacity", "transform"], `${name} animates ${prop}`).toContain(prop);
    }
    for (const selector of [".notes", ".is-swap > *"]) {
      const animation = /animation:\s*([^;]*);/.exec(rule(notes, selector))?.[1] ?? "";
      expect(animation, selector).toContain("var(--ease-out)");
      expect(animation, `${selector} leaves the animation list when it ends`).not.toMatch(/both|forwards/);
    }
  });

  it("the box stacks over the slide's shadow", () => {
    expect(rule(notes, ".notes")).toMatch(/position:\s*relative;[\s\S]*z-index:\s*1;/);
  });
});
