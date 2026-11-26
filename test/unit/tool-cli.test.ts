import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const TOOLS = fileURLToPath(new URL("../../tools/", import.meta.url));

describe("tool CLIs run when reached through a symlink", { timeout: SPAWN_TIMEOUT }, () => {
  it("every tools/*.mjs that checks it runs as main compares real paths on both sides", () => {
    const plain = readdirSync(TOOLS)
      .filter((f) => f.endsWith(".mjs"))
      .filter((f) => {
        const src = readFileSync(join(TOOLS, f), "utf8");
        const guard = src.split("\n").find((l) => /process\.argv\[1\]/.test(l) && /import\.meta\.url/.test(l));
        return (
          guard != null &&
          !/realpathSync\(process\.argv\[1\]\).*realpathSync\(fileURLToPath\(import\.meta\.url\)\)/.test(guard)
        );
      });
    expect(plain).toEqual([]);
  });

  it("land.mjs and size-ratchet.mjs act when run through a symlinked tools/ folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "tools-link-"));
    const link = join(dir, "tools");
    symlinkSync(TOOLS, link);
    try {
      const land = spawnSync(process.execPath, [join(link, "land.mjs")], { encoding: "utf8" });
      expect([land.status, land.stderr.trim()]).toEqual([64, "usage: node tools/land.mjs <sha> [--dry-run]"]);
      const ratchet = spawnSync(process.execPath, [join(link, "size-ratchet.mjs")], {
        encoding: "utf8",
        cwd: join(TOOLS, ".."),
        env: { ...process.env, GITHUB_REF_NAME: "main", BEFORE: "" },
      });
      expect(`${ratchet.stdout}${ratchet.stderr}`).toMatch(/size ratchet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
