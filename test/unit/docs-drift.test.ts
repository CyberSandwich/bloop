import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}

describe("threat model", () => {
  it("every mitigated row has its id in a test title", () => {
    const rows = read("docs/threat-model.md")
      .split("\n")
      .filter((line) => /^\| [A-Z]+-\d+ \|/.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const mitigated = rows.filter((cells) => cells[cells.length - 2] === "mitigated").map((cells) => cells[1] ?? "");
    expect(mitigated.length).toBeGreaterThan(20);

    const titles = walk("test", (path) => /\.(test|spec)\.ts$/.test(path))
      .flatMap((path) => read(path).match(/\b(?:it|describe|test)(?:\.\w+)?\(\s*["'`][^"'`]*/g) ?? [])
      .join("\n");
    const untested = mitigated.filter((id) => !titles.includes(id));
    expect(untested, "mitigated rows with no test title containing their id").toEqual([]);
  });
});
