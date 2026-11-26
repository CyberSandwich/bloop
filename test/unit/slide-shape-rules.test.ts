import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A page's box takes the page's own shape (its natural size: aspect-ratio auto, or --ratio from a script), never an assumed
// deck shape: a 16 : 10 preview and 1920 x 1200 slides letterboxed the 16 : 9 deck.
const PUBLIC = new URL("../../public/", import.meta.url).pathname;
const files = (dir: string, ext: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
/** Each match of `pattern` in the files under public/`dir`, as `file: match`. */
const hits = (dir: string, ext: string, pattern: RegExp): string[] =>
  files(join(PUBLIC, dir), ext).flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(pattern)].map((m) => `${f.slice(PUBLIC.length)}: ${m[0]}`),
  );

describe("no box hard-codes a page's shape", () => {
  it("takes every CSS aspect-ratio from the thing shown (auto, or --ratio), a fallback only until it loads", () => {
    // The library's stage is a fixed frame that letterboxes whatever it holds, a photo or a page, by design.
    expect(
      hits("css", ".css", /^[^\n{}]*\{[^}]*?aspect-ratio:(?!\s*(?:var\(--ratio|auto\b))[^;]*;/gm).filter(
        (h) => !h.startsWith("css/library-sheets.css: .lib-stage"),
      ),
    ).toEqual([]);
  });

  it("builds no picture with a literal width or height", () => {
    expect(hits("js", ".js", /el\("img",\s*\{(?:[^}]|\}(?!\)))*?\b(?:width|height):\s*"\d+"/g)).toEqual([]);
  });
});
