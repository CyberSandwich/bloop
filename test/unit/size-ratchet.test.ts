import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baseRefFor, compare, entriesFrom, parseLimit } from "../../tools/size-ratchet.mjs";

const entry = (name: string, limit: string, path: string | string[] = `dist/js/${name}.js`) => ({ name, path, limit });
/** Which public/ files the base and HEAD hold; every other file is in neither. */
const files = (onBase: string[], onHead: string[]) => ({
  onBase: (p: string) => onBase.includes(p),
  onHead: (p: string) => onHead.includes(p),
});
const src = (name: string) => `public/js/${name}.js`;
const both = (...names: string[]) => files(names.map(src), names.map(src));

describe("size ratchet: a budget only holds or drops", () => {
  it("size ratchet: a raised limit fails, naming the entry and both values", () => {
    expect(compare([entry("app", "7.1 kB")], [entry("app", "7.2 kB")], both("app"))).toEqual([
      '"app" limit raised from 7.1 kB to 7.2 kB',
    ]);
  });

  it("size ratchet: a raise across units is still a raise, and 1 B over counts", () => {
    expect(compare([entry("a", "0.2 kB")], [entry("a", "201 B")], both("a"))).toHaveLength(1);
    expect(compare([entry("a", "1000 B")], [entry("a", "1 kB")], both("a"))).toEqual([]);
  });

  it("size ratchet: a new entry for a new file, a lowered limit and an unchanged one pass", () => {
    const base = [entry("app", "7.1 kB"), entry("site", "6.15 kB")];
    const head = [entry("app", "7.0 kB"), entry("site", "6.15 kB"), entry("sheen", "0.72 kB")];
    const has = files([src("app"), src("site")], [src("app"), src("site"), src("sheen")]);
    expect(compare(base, head, has)).toEqual([]);
  });

  it("size ratchet: a removed entry passes once its file is deleted, and fails while the file stays", () => {
    const base = [entry("old", "1 kB")];
    expect(compare(base, [], files([src("old")], []))).toEqual([]);
    expect(compare(base, [], both("old"))).toEqual(['"old" was removed but HEAD still has public/js/old.js']);
  });

  it("size ratchet: a removed entry fails closed for a glob, a path with no public/ source, or a file never seen", () => {
    expect(compare([entry("css", "9 kB", "dist/css/*.css")], [], files([], []))).toHaveLength(1);
    expect(compare([entry("x", "1 kB", "build/x.js")], [], files([], []))).toHaveLength(1);
    expect(compare([entry("ghost", "1 kB")], [], files([], []))).toEqual([
      '"ghost" was removed but HEAD still has public/js/ghost.js',
    ]);
  });

  it("size ratchet: a rename by name or by path cannot carry a raise", () => {
    const head = [{ ...entry("app2", "8 kB"), path: "dist/js/app.js" }];
    expect(compare([entry("app", "7.1 kB")], head, both("app"))).toEqual(['"app2" limit raised from 7.1 kB to 8 kB']);
  });

  it("size ratchet: a file renamed with its entry passes at the same limit and fails over it", () => {
    const moved = files([src("old")], [src("new")]);
    expect(compare([entry("old", "2 kB")], [entry("new", "2 kB")], moved)).toEqual([]);
    expect(compare([entry("old", "2 kB")], [entry("new", "2.1 kB")], moved)).toEqual([
      'measure changed, review: "new" sum to 2.1 kB, over the 2 kB of "old" they replace',
    ]);
  });

  it("size ratchet: a split moves bytes but never adds them", () => {
    const base = [entry("page", "7 kB", ["dist/js/page.js", "dist/js/lazy.js"])];
    const fits = [entry("page", "5 kB", ["dist/js/page.js"]), entry("lazy", "2 kB")];
    const grows = [entry("page", "7 kB", ["dist/js/page.js"]), entry("lazy", "2 kB")];
    expect(compare(base, fits, both("page", "lazy"))).toEqual([]);
    expect(compare(base, grows, both("page", "lazy"))).toEqual([
      'measure changed, review: "page", "lazy" sum to 9 kB, over the 7 kB of "page" they replace',
    ]);
  });

  it("size ratchet: a changed import or ignore set counts as a moved measure", () => {
    const base = [{ ...entry("app", "7 kB"), import: "{ a }" }];
    expect(compare(base, [{ ...entry("app", "7 kB"), import: "{ a, b }" }], both("app"))).toEqual([]);
    const grown = [{ ...entry("app", "7 kB"), ignore: ["x"] }, entry("x", "1 kB", "dist/js/app.js")];
    expect(compare([entry("app", "7 kB")], grown, both("app"))[0]).toMatch(/^measure changed, review/);
  });

  it("size ratchet: compression follows size-limit's precedence, gzip first", () => {
    const one = (extra: object) => [{ ...entry("css", "4 kB"), ...extra }];
    expect(compare(one({}), one({ gzip: true }), both("css"))).toEqual([
      '"css" compression changed from brotli to gzip',
    ]);
    expect(compare(one({ gzip: true }), one({ gzip: true, brotli: false }), both("css"))).toEqual([]);
    expect(compare(one({ brotli: false }), one({ brotli: false, gzip: false }), both("css"))).toEqual([]);
  });

  it("size ratchet: limits parse as size-limit parses them; an unreadable one throws", () => {
    expect(parseLimit("0.72 kB")).toBe(720);
    expect(parseLimit("720")).toBe(720);
    expect(parseLimit(720)).toBe(720);
    expect(parseLimit("1 kb")).toBe(1000);
    expect(parseLimit("1KB")).toBe(1000);
    expect(parseLimit("1 KiB")).toBe(1024);
    expect(parseLimit("2 MB")).toBe(2_000_000);
    expect(() => parseLimit("7.1 kb!")).toThrow();
    expect(() => parseLimit("fast")).toThrow();
  });

  it("size ratchet: entries are read from package.json, .size-limit.json and tools/size/*.json", () => {
    const tree: Record<string, string> = {
      "package.json": JSON.stringify({ "size-limit": [entry("a", "1 kB")] }),
      ".size-limit.json": JSON.stringify([entry("b", "2 kB")]),
      "tools/size/extra.json": JSON.stringify(entry("c", "3 kB")),
      "tools/size/notes.txt": "not config",
    };
    const at = {
      show: (f: string) => tree[f] ?? null,
      list: (dir: string) => Object.keys(tree).filter((f) => f.startsWith(`${dir}/`)),
    };
    expect(entriesFrom(at).map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("size ratchet: every entry in package.json measures a file with a public/ source", () => {
    const root = new URL("../../", import.meta.url);
    const entries: { name: string; path: string | string[] }[] = JSON.parse(
      readFileSync(new URL("package.json", root), "utf8"),
    )["size-limit"];
    const unchecked = entries.flatMap((e) =>
      [e.path].flat().filter((p) => !existsSync(new URL(p.replace(/^dist\//, "public/"), root))),
    );
    expect(unchecked).toEqual([]);
  });
});

describe("size ratchet: the base", () => {
  const sha = "a".repeat(40);
  const at = (branch: string, before: string, reachable = true) =>
    baseRefFor({ branch, before, isCommit: () => reachable, mergeBase: () => "MERGE_BASE" });

  it("size ratchet: off main it is the merge-base with origin/main, whatever BEFORE says", () => {
    expect(at("ci/x", sha)).toBe("MERGE_BASE");
    expect(at("12/merge", "")).toBe("MERGE_BASE");
  });

  it("size ratchet: on main it is the push's previous tip when that is a commit here", () => {
    expect(at("main", sha)).toBe(sha);
  });

  it("size ratchet: on main it falls back to HEAD~1 for zeros, an unreachable tip, none, or junk", () => {
    expect(at("main", "0".repeat(40))).toBe("HEAD~1");
    expect(at("main", sha, false)).toBe("HEAD~1");
    expect(at("main", "")).toBe("HEAD~1");
    expect(at("main", "HEAD; rm -rf /")).toBe("HEAD~1");
  });

  it("size ratchet: ci runs it in the check job, with the history it needs", () => {
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const check = ci.slice(ci.indexOf("  check:"), ci.indexOf("  browser:"));
    expect(check).toMatch(/fetch-depth: 0/);
    expect(check).toMatch(/run: node tools\/size-ratchet\.mjs/);
    expect(check).toMatch(/BEFORE: \$\{\{ github\.event\.before \}\}/);
  });
});
