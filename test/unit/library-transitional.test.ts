// The library's stand-ins for dependencies that have not landed: each is marked `transitional: <owner>:` in the code.
// The list is empty before the library's final land; a marker found and not listed fails, as does a listed one gone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });

/** `<file>: <owner>`, one per marker still allowed. */
const ALLOWED = [
  "src/worker/library/wiring.ts: A",
  "src/worker/library/wiring.ts: U",
  "src/worker/library/wiring.ts: V2",
  "src/worker/library/sample.ts: U",
  "src/worker/library/wire.ts: U",
  "src/worker/live-screens.ts: P1",
  "src/worker/seams/file-source/library.ts: U",
  "src/worker/routes/library.ts: G",
  "src/worker/routes/library.ts: G",
  "public/js/library.js: A",
  "public/js/library.js: U",
  "public/js/library/preview.js: P1",
];

describe("library transitional seams", () => {
  it("every `transitional: <owner>:` marker is one still allowed, and each allowed one is present", () => {
    const found = [...walk("src"), ...walk("public/js")].flatMap((path) =>
      [...readFileSync(join(root, path), "utf8").matchAll(/transitional: (A|G|U|V2|P1):/g)].map(
        (m) => `${path}: ${m[1]}`,
      ),
    );
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });
});
