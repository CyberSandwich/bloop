// Transitional seams between P1's commits: each is marked in the code, and each deleting commit shrinks this list.
// It is empty once the library is the only live source; a marker found and not listed fails, as does a listed one gone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });

/** `<file>: <owner>` for every marker still allowed: a P1 commit, or the stream that fills a seam. */
const ALLOWED = [
  "src/worker/machine/lists.ts: P1 commit 5",
  "src/worker/do/screen.ts: P1 commit 6",
  "src/worker/do/screen.ts: P2",
  "src/worker/do/schema.ts: P1 commit 6",
  "src/worker/do/effects.ts: R9",
  "src/worker/routes/pairing.ts: P1 commit 4",
  "src/worker/routes/pairing.ts: P1 commit 4",
  "src/worker/routes/open.ts: P1 commit 4",
  "src/worker/seams/open-path/lookups.ts: P1 commit 4",
];

describe("transitional seams", () => {
  it("every `transitional: removed in <owner>` marker is one still allowed, and each allowed one is present", () => {
    const found = walk("src").flatMap((path) =>
      [...readFileSync(join(root, path), "utf8").matchAll(/transitional: removed in (P1 commit \d+|P\d|R\d+)/g)].map(
        (m) => `${path}: ${m[1]}`,
      ),
    );
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });
});
