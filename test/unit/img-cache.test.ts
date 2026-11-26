// /img is cached for a day plus a week of stale-while-revalidate, so a picture whose bytes change under the same name
// is shown stale. Every file in public/img therefore either sits in a versioned set (its name carries a hash of its
// bytes, so new bytes are a new URL) or is on the REVALIDATE list, which _headers serves `no-cache` (an ETag check on
// every use). A new picture that is neither fails here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { staticHeaders as resolve } from "../../tools/static-headers.mjs";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const IMG_DIR = "public/img";
const HEADERS_FILE = readFileSync("public/_headers", "utf8");
const SITE_HOST = new URL(wranglerConfig(readFileSync("wrangler.jsonc", "utf8")).vars.PUBLIC_ORIGIN).host;
const headersOf = (file: string) => resolve(HEADERS_FILE, `/img/${file}`, SITE_HOST);

/** A set of pictures whose names carry a hash of their bytes (`stem.<8 hex>.ext`): `owns` picks its files. */
type VersionedSet = { name: string; owns: (file: string) => boolean; hashOf: (file: string) => string };
const SETS: VersionedSet[] = [];
/** Files whose bytes may change under the same name: served `no-cache`. The demo's pictures are replaced with the deck. */
const REVALIDATE = [/^demo-/];
/** Pictures whose set has not been added yet: each entry leaves with the change that adds its set. */
const PENDING = [/^hero-viewer-/];

const files = readdirSync(IMG_DIR);

describe("/img: a changed picture is never served stale", () => {
  it("every file is in a versioned set or on the REVALIDATE list", () => {
    const loose = files.filter(
      (f) => !SETS.some((s) => s.owns(f)) && !REVALIDATE.some((r) => r.test(f)) && !PENDING.some((p) => p.test(f)),
    );
    expect(loose, "version it in a set (stem.<hash>.ext), or add it to REVALIDATE").toEqual([]);
  });

  it("every file of a set is named stem.hash.ext with its hash", () => {
    for (const set of SETS) {
      const owned = files.filter((f) => set.owns(f));
      expect(owned.length, set.name).toBeGreaterThan(0);
      for (const file of owned) {
        const m = /^(.+)\.([0-9a-f]{8})\.(\w+)$/.exec(file);
        expect(m, `${file} must read <stem>.<8 hex>.<ext>`).not.toBeNull();
        expect(m?.[2], `${file} must read .${set.hashOf(file)}.`).toBe(set.hashOf(file));
      }
    }
  });

  it("every REVALIDATE file is served no-cache by _headers, never with a max-age", () => {
    const owned = files.filter((f) => REVALIDATE.some((r) => r.test(f)));
    expect(owned.length).toBeGreaterThan(0);
    for (const file of owned) expect(headersOf(file)["cache-control"], file).toBe("no-cache");
  });

  it("the Worker adds no image cache rule of its own over _headers", () => {
    const worker = readFileSync("src/worker/headers.ts", "utf8");
    expect(worker).not.toMatch(/\/img\//);
  });

  it("every literal /img path in the pages, scripts, styles and size budgets names a file that exists", () => {
    const sources = [
      ...(readdirSync("public", { recursive: true }) as string[])
        .filter((f) => /\.(html|js|css)$/.test(f))
        .map((f) => join("public", f)),
      "tools/size/core.json",
    ];
    let seen = 0;
    for (const path of sources) {
      for (const [ref] of readFileSync(path, "utf8").matchAll(/\/img\/[A-Za-z0-9._-]+\.(?:webp|avif|png|jpe?g|svg)/g)) {
        seen++;
        expect(files, `${path} names ${ref}, which is not in public/img`).toContain(ref.slice("/img/".length));
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
