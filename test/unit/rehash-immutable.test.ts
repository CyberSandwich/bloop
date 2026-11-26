import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtFiles, staleBuilt } from "../../tools/build-assets.mjs";
import { rehash, rewriteRefs } from "../../tools/rehash-immutable.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), "bloop-rehash-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

describe("rehash-immutable", () => {
  it("rewrites each old name, wherever it appears", () => {
    const renames = new Map([["a-00000000.woff2", "a-1234abcd.woff2"]]);
    expect(rewriteRefs('url("/fonts/a-00000000.woff2") /fonts/a-00000000.woff2', renames)).toBe(
      'url("/fonts/a-1234abcd.woff2") /fonts/a-1234abcd.woff2',
    );
  });

  it("replaces a name only where it stands alone as a segment", () => {
    const renames = new Map([["a-00000000.woff2", "a-1234abcd.woff2"]]);
    expect(rewriteRefs('xa-00000000.woff2 a-00000000.woff2x /a-00000000.woff2"', renames)).toBe(
      'xa-00000000.woff2 a-00000000.woff2x /a-1234abcd.woff2"',
    );
  });

  it("hashes the built bytes, and settles when a unit's references change its own hash", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    repo({
      "public/js/vendor/lib-00000000/x.js": "/* gone */ export const x = 1;",
      "public/js/workers/w-00000000/w.js": 'import "../../vendor/lib-00000000/x.js";',
    });
    const renames = rehash(root);
    // The worker is renamed twice: once for its own bytes, again for the new name of the library it imports.
    expect(renames.has("lib-00000000")).toBe(true);
    expect([...renames.keys()].filter((name) => name.startsWith("w-")).length).toBe(2);
    expect(staleBuilt(builtFiles(root))).toEqual([]);
  });

  it("renames a unit to its hash and follows every reference, then finds nothing left to do", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    repo({
      "public/fonts/f-00000000.woff2": "font bytes",
      "public/js/vendor/lib-00000000/x.js": "x",
      "public/css/base.css": 'src: url("/fonts/f-00000000.woff2")',
      "public/js/core/q.js": 'import "../vendor/lib-00000000/x.js";',
      "docs/note.md": "no refs here",
    });
    const renames = rehash(root);
    expect([...renames.keys()].sort()).toEqual(["f-00000000.woff2", "lib-00000000"]);
    expect(existsSync(join(root, "public/fonts/f-00000000.woff2"))).toBe(false);
    const font = [...renames.values()].find((name) => name.endsWith(".woff2")) ?? "";
    const lib = [...renames.values()].find((name) => name.startsWith("lib-")) ?? "";
    expect(readFileSync(join(root, "public/css/base.css"), "utf8")).toContain(`/fonts/${font}`);
    expect(readFileSync(join(root, "public/js/core/q.js"), "utf8")).toContain(`vendor/${lib}/x.js`);
    expect(readFileSync(join(root, `public/fonts/${font}`), "utf8")).toBe("font bytes");
    expect(rehash(root).size).toBe(0);
    expect(staleBuilt(builtFiles(root))).toEqual([]);
  });

  it("refuses a unit with no hash in its name", { timeout: SPAWN_TIMEOUT }, () => {
    repo({ "public/fonts/plain.woff2": "x" });
    expect(() => rehash(root)).toThrow(/add -00000000/);
  });
});
