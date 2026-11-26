import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLIDES } from "../../public/js/core/demo.js";
import { orderItems } from "../../public/js/shared/session.js";
import { DECK_PAGES, DEMO_IDS, DEMO_ITEMS, DEMO_NAMES } from "../../src/shared/demo-catalog.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["test", "public/js", "src"];
/** The catalog itself and this rule. */
const EXEMPT = new Set([
  "src/shared/demo-catalog.ts",
  "public/js/core/demo.js",
  "test/unit/site-pages.test.ts",
  "test/e2e/landing.spec.ts",
  "test/unit/demo-catalog-rules.test.ts",
]);
const LITERALS: [RegExp, string][] = [
  [/["'`](Horizontal\.jpg|Vertical\.jpg)["'`]/, "a demo photo's name"],
  [/["'`]demo-(deck|dog|horizontal|vertical|vevox|video|pdf)["'`]/, "a demo item's id"],
  [/Th8JoIan4dg|Evaluate Startup Ideas/, "the demo video's id or title"],
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
  it("no test or module types a demo item's name, id or page count: it imports them", () => {
    const found = ROOTS.flatMap((r) => walk(join(ROOT, r))).flatMap((file) => {
      const rel = file.slice(ROOT.length);
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
    // The list is the approved list's own order (files by name, then links by title), so a slot never moves at approval.
    const files = [DEMO_ITEMS.deck, DEMO_ITEMS.horizontal, DEMO_ITEMS.vertical].map((i) => ({
      kind: "file" as const,
      name: i.name,
    }));
    const links = [DEMO_ITEMS.video, DEMO_ITEMS.link].map((i) => ({ kind: "link" as const, title: i.name }));
    const ordered = orderItems([...links, ...files].reverse()).map((i) => (i.kind === "file" ? i.name : i.title));
    expect(DEMO_NAMES).toEqual(ordered);
    expect(Object.values(DEMO_ITEMS).map((i) => i.slot)).toEqual(DEMO_NAMES.map((_, i) => `i${i + 1}`));
    expect(new Set(DEMO_IDS).size).toBe(DEMO_IDS.length);
  });
});
