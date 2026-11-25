import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("./", import.meta.url));
/** Files that start a process only at module load, where no test timeout applies. */
const AT_LOAD_ONLY = new Set(["docs-drift.test.ts"]);

describe("unit tests that start a process", () => {
  it("each one runs under SPAWN_TIMEOUT, never vitest's 5 s default", () => {
    const missing = readdirSync(DIR)
      .filter((f) => f.endsWith(".test.ts") && !AT_LOAD_ONLY.has(f))
      .filter((f) => {
        const src = readFileSync(`${DIR}${f}`, "utf8");
        return /from "node:child_process"/.test(src) && !/timeout: SPAWN_TIMEOUT/.test(src);
      });
    expect(missing).toEqual([]);
  });
});
