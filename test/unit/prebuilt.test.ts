import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesOf, MANIFEST, manifestProblems } from "../../tools/prebuilt.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A dist/ with a dotfile and a dot folder, plus the manifest of it. */
function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), "prebuilt-"));
  roots.push(dir);
  mkdirSync(join(dir, ".well-known"));
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  writeFileSync(join(dir, ".assetsignore"), "*.d.ts\n");
  writeFileSync(join(dir, ".well-known", "security.txt"), "Contact: x\n");
  writeFileSync(join(dir, MANIFEST), JSON.stringify(filesOf(dir)));
  return dir;
}

describe("SITE-05 prebuilt manifest", () => {
  it("SITE-05 token jobs: the manifest lists dotfiles and not itself, and a dist/ equal to it passes", () => {
    const dir = dist();
    expect(Object.keys(filesOf(dir))).toEqual([".assetsignore", ".well-known/security.txt", "index.html"]);
    expect(manifestProblems(dir)).toEqual([]);
  });

  it("SITE-05 token jobs: a dist/ that lost .assetsignore or .well-known fails the assert", () => {
    const lost = dist();
    rmSync(join(lost, ".assetsignore"));
    expect(manifestProblems(lost)).toEqual([".assetsignore is missing"]);
    const folder = dist();
    rmSync(join(folder, ".well-known"), { recursive: true });
    expect(manifestProblems(folder)).toEqual([".well-known/security.txt is missing"]);
  });

  it("SITE-05 token jobs: changed bytes, an extra file and a missing manifest each fail", () => {
    const changed = dist();
    writeFileSync(join(changed, "index.html"), "<p>other</p>");
    expect(manifestProblems(changed)).toEqual(["index.html changed"]);
    const extra = dist();
    writeFileSync(join(extra, "extra.js"), "1");
    expect(manifestProblems(extra)).toEqual(["extra.js is not in the manifest"]);
    const none = dist();
    rmSync(join(none, MANIFEST));
    expect(manifestProblems(none)).toEqual([`${MANIFEST} is missing`]);
  });
});
