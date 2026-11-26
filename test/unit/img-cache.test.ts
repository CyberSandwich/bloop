// A picture whose bytes change under the same name is shown stale for as long as it is cached, in browsers and at the
// edge. So every file in public/img is one of two classes, decided by its name through the real `_headers` rules:
// a name carrying a hash of the file's bytes (`stem.<8 hex>.ext`) is immutable, and any other is revalidated by ETag.
// The rule matches any name with two dots, so a file with a second dot must be hashed, and rightly.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { staticHeaders as resolve } from "../../tools/static-headers.mjs";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const IMG_DIR = "public/img";
const HEADERS_FILE = readFileSync("public/_headers", "utf8");
const SITE_HOST = new URL(wranglerConfig(readFileSync("wrangler.jsonc", "utf8")).vars.PUBLIC_ORIGIN).host;
const headersOf = (file: string) => resolve(HEADERS_FILE, `/img/${file}`, SITE_HOST);
const hashOf = (file: string) =>
  createHash("sha256")
    .update(readFileSync(join(IMG_DIR, file)))
    .digest("hex")
    .slice(0, 8);
const HASHED = /^(.+)\.([0-9a-f]{8})\.(\w+)$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

const files = readdirSync(IMG_DIR);

describe("/img: a changed picture is never served stale", () => {
  it("a file with a second dot in its name is hashed, and the hash is its own bytes'", () => {
    for (const file of files.filter((f) => f.split(".").length > 2)) {
      const m = HASHED.exec(file);
      expect(m, `${file} must read <stem>.<8 hex>.<ext>`).not.toBeNull();
      expect(m?.[2], `${file} must read .${hashOf(file)}.`).toBe(hashOf(file));
    }
  });

  it("a hashed name is immutable and every other name is no-cache", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(headersOf(file)["cache-control"], file).toBe(HASHED.test(file) ? IMMUTABLE : "no-cache");
    }
  });

  it("the rules by name alone: one dot is revalidated, two are immutable, and nothing is a plain max-age", () => {
    for (const name of ["demo-slide-1.webp", "hero.avif", "a.b"])
      expect(headersOf(name)["cache-control"], name).toBe("no-cache");
    expect(headersOf("x.0123abcd.webp")["cache-control"]).toBe(IMMUTABLE);
    for (const name of [...files, "x.0123abcd.webp"]) {
      expect(headersOf(name)["cache-control"], name).toMatch(/^(no-cache|public, max-age=31536000, immutable)$/);
    }
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
