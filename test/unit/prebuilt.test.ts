import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("SITE-05 token jobs: a symlinked file or folder fails the assert, so a link cannot publish a file from outside dist/", () => {
    const file = dist();
    symlinkSync("/etc/hosts", join(file, "link.txt"));
    expect(() => manifestProblems(file)).toThrow(/link\.txt is not a plain file or folder/);
    const folder = dist();
    symlinkSync("/etc", join(folder, "linked-dir"));
    expect(() => manifestProblems(folder)).toThrow(/linked-dir is not a plain file or folder/);
    const dangling = dist();
    symlinkSync("/nonexistent/target", join(dangling, "dangling"));
    expect(() => manifestProblems(dangling)).toThrow(/dangling is not a plain file or folder/);
  });

  it("SITE-05 token jobs: a file named __proto__ or toString is an ordinary name, listed and compared", () => {
    const dir = dist();
    writeFileSync(join(dir, "__proto__"), "1");
    writeFileSync(join(dir, "toString"), "1");
    expect(manifestProblems(dir)).toEqual(["__proto__ is not in the manifest", "toString is not in the manifest"]);
    writeFileSync(join(dir, MANIFEST), JSON.stringify(filesOf(dir)));
    expect(Object.keys(filesOf(dir))).toContain("__proto__");
    expect(manifestProblems(dir)).toEqual([]);
    writeFileSync(join(dir, "__proto__"), "2");
    expect(manifestProblems(dir)).toEqual(["__proto__ changed"]);
  });
});
