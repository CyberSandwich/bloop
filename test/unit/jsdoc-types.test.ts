import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const tsc = path("../../node_modules/typescript/bin/tsc");
const check = (config: string) =>
  spawnSync(process.execPath, [tsc, "-p", path(`../fixtures/jsdoc/${config}`)], { encoding: "utf8" });

describe("browser JS typed by JSDoc against src/shared/protocol.ts", () => {
  it("accepts a module that imports a type through @import and uses it correctly", () => {
    const result = check("tsconfig.json");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects a module that assigns a value outside the imported type", () => {
    const result = check("tsconfig.bad.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("not-a-state");
  });
});
