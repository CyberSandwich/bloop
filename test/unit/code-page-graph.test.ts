import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const JS = resolve(import.meta.dirname, "../../public/js");

/** Every module a page's entry script reaches through static relative imports and re-exports. */
function reach(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, "utf8");
  for (const m of src.matchAll(/^(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gm)) {
    reach(resolve(dirname(entry), m[1] as string), seen);
  }
  return seen;
}

const names = (entry: string) => [...reach(resolve(JS, entry))].map((f) => relative(JS, f)).sort();

describe("/code import graph", () => {
  it("does not reach the icon table or format.js", () => {
    const files = names("code.js");
    expect(files).toContain("core/typed.js");
    expect(files).not.toContain("core/icons.js");
    expect(files).not.toContain("core/format.js");
  });
});
