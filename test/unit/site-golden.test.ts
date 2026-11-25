// MODE-01: the preview site pages, as served, equal a checked-in copy, so no later change reaches preview unseen.
// A deliberate preview change regenerates the copy (`GOLDEN_UPDATE=1 npx vitest run test/unit/site-golden.test.ts`)
// in a commit whose message says "preview change".
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../tools/build-assets.mjs";
import { buildAll } from "../../tools/build-pages.mjs";

const GOLDEN = fileURLToPath(new URL("../fixtures/site-preview/", import.meta.url));

/** Every page the page build owns, as the browser receives it (comments stripped), keyed by its path under public/. */
function served() {
  return new Map(
    [...buildAll()]
      .filter(([rel]) => rel.endsWith(".html"))
      .map(([rel, html]) => [rel.replace(/^public\//, ""), stripComments(html, rel)] as const),
  );
}

const golden = () =>
  readdirSync(GOLDEN, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(GOLDEN.length));

describe("MODE-01 preview pages equal the golden copy", () => {
  it("every preview page matches its fixture, and no fixture is left over", () => {
    const pages = served();
    if (process.env.GOLDEN_UPDATE) {
      rmSync(GOLDEN, { recursive: true, force: true });
      for (const [rel, html] of pages) {
        mkdirSync(dirname(join(GOLDEN, rel)), { recursive: true });
        writeFileSync(join(GOLDEN, rel), html);
      }
    }
    expect(golden().sort()).toEqual([...pages.keys()].sort());
    for (const [rel, html] of pages) {
      expect(existsSync(join(GOLDEN, rel)), rel).toBe(true);
      expect(html === readFileSync(join(GOLDEN, rel), "utf8"), `${rel} differs from test/fixtures/site-preview`).toBe(
        true,
      );
    }
  });
});
