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

/** `<file>: commit <n>` for every marker still allowed. */
const ALLOWED = ["src/worker/machine/pairing.ts: commit 3", "src/worker/machine/lists.ts: commit 5"];

describe("transitional seams", () => {
  it("every `transitional: removed in P1 commit N` marker is one still allowed, and each allowed one is present", () => {
    const found = walk("src").flatMap((path) =>
      [...readFileSync(join(root, path), "utf8").matchAll(/transitional: removed in P1 commit (\d+)/g)].map(
        (m) => `${path}: commit ${m[1]}`,
      ),
    );
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });
});
