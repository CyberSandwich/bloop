import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLIDES } from "../../public/js/core/demo.js";
import { DECK_PAGES, DEMO_IDS, DEMO_ITEMS, DEMO_NAMES } from "../../src/shared/demo-catalog.ts";

const TEST = fileURLToPath(new URL("../", import.meta.url));
/** Files that may name what they test without the catalog: the landing's static example is the landing's own copy. */
const EXEMPT = new Set(["unit/site-pages.test.ts", "e2e/landing.spec.ts", "unit/demo-catalog-rules.test.ts"]);
const LITERALS: [RegExp, string][] = [
  [/["'`](Horizontal\.jpg|Vertical\.jpg)["'`]/, "a demo photo's name"],
  [/["'`]demo-(deck|dog|horizontal|vertical|vevox|pdf)["'`]/, "a demo item's id"],
  [/Sample deck\.(pptx|pdf)/, "the retired sample deck's name"],
  [/\b(Slide|Page) \d+ of \d+/, "a page count in an accessible name"],
  [/["'`]\d \/ \d["'`]/, "a page indicator"],
];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "fixtures"
        ? []
        : walk(join(dir, e.name))
      : /\.(ts|js)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("the demo catalog has one owner (src/shared/demo-catalog.ts)", () => {
  it("no test types a demo item's name, id or page count: it imports them", () => {
    const found = walk(TEST).flatMap((file) => {
      const rel = file.slice(TEST.length);
      if (EXEMPT.has(rel)) return [];
      const lines = readFileSync(file, "utf8").split("\n");
      return lines.flatMap((line, i) =>
        LITERALS.filter(([re]) => re.test(line)).map(([, what]) => `${rel}:${i + 1} types ${what}`),
      );
    });
    expect(found).toEqual([]);
  });

  it("the viewer and the list order agree with the catalog", () => {
    expect(SLIDES).toHaveLength(DECK_PAGES);
    expect(DEMO_IDS).toHaveLength(DEMO_NAMES.length);
    expect(DEMO_NAMES).toEqual(
      [...DEMO_NAMES].sort((a, b) =>
        a === DEMO_ITEMS.link.name ? 1 : b === DEMO_ITEMS.link.name ? -1 : a.localeCompare(b),
      ),
    );
  });
});
