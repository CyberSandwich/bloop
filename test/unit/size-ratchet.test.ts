import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, entriesFrom, parseLimit } from "../../tools/size-ratchet.mjs";

const entry = (name: string, limit: string, path = `dist/js/${name}.js`) => ({ name, path, limit });
const nothingExists = () => false;
const everythingExists = () => true;

describe("size ratchet: a budget only holds or drops", () => {
  it("size ratchet: a raised limit fails, naming the entry and both values", () => {
    expect(compare([entry("app", "7.1 kB")], [entry("app", "7.2 kB")], everythingExists)).toEqual([
      '"app" limit raised from 7.1 kB to 7.2 kB',
    ]);
  });

  it("size ratchet: a raise across units is still a raise, and 1 B over counts", () => {
    expect(compare([entry("a", "0.2 kB")], [entry("a", "201 B")], everythingExists)).toHaveLength(1);
    expect(compare([entry("a", "1000 B")], [entry("a", "1 kB")], everythingExists)).toEqual([]);
  });

  it("size ratchet: a new entry, a lowered limit and an unchanged one pass", () => {
    const base = [entry("app", "7.1 kB"), entry("site", "6.15 kB")];
    const head = [entry("app", "7.0 kB"), entry("site", "6.15 kB"), entry("sheen", "0.72 kB")];
    expect(compare(base, head, everythingExists)).toEqual([]);
  });

  it("size ratchet: a removed entry passes once its file is deleted, and fails while the file stays", () => {
    const base = [entry("old", "1 kB")];
    expect(compare(base, [], nothingExists)).toEqual([]);
    expect(compare(base, [], (p) => p === "public/js/old.js")).toEqual([
      '"old" was removed but HEAD still has public/js/old.js',
    ]);
  });

  it("size ratchet: a glob entry removed fails closed, since its files cannot be checked one by one", () => {
    expect(compare([entry("css", "9 kB", "dist/css/*.css")], [], nothingExists)).toHaveLength(1);
  });

  it("size ratchet: a rename cannot carry a raise past it (matched by path)", () => {
    const head = [{ ...entry("app2", "8 kB"), path: "dist/js/app.js" }];
    expect(compare([entry("app", "7.1 kB")], head, everythingExists)).toEqual([
      '"app2" limit raised from 7.1 kB to 8 kB',
    ]);
  });

  it("size ratchet: switching an entry's compression fails, since it moves what the limit measures", () => {
    const head = [{ ...entry("css", "4 kB"), gzip: true }];
    expect(compare([entry("css", "4 kB")], head, everythingExists)).toEqual([
      '"css" compression changed from brotli to gzip',
    ]);
  });

  it("size ratchet: an unreadable limit throws instead of passing", () => {
    expect(() => parseLimit("7.1 kb!")).toThrow();
    expect(() => parseLimit("fast")).toThrow();
    expect(parseLimit("0.72 kB")).toBe(720);
  });

  it("size ratchet: entries are read from package.json, .size-limit.json and tools/size/*.json", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ "size-limit": [entry("a", "1 kB")] }),
      ".size-limit.json": JSON.stringify([entry("b", "2 kB")]),
      "tools/size/extra.json": JSON.stringify(entry("c", "3 kB")),
      "tools/size/notes.txt": "not config",
    };
    const tree = {
      show: (f: string) => files[f] ?? null,
      list: (dir: string) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)),
    };
    expect(entriesFrom(tree).map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("size ratchet: ci runs it in the check job, with the history it needs", () => {
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const check = ci.slice(ci.indexOf("  check:"), ci.indexOf("  browser:"));
    expect(check).toMatch(/fetch-depth: 0/);
    expect(check).toMatch(/run: node tools\/size-ratchet\.mjs/);
    expect(check).toMatch(/BEFORE: \$\{\{ github\.event\.before \}\}/);
  });
});
