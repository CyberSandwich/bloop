import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { webpSize } from "../../src/worker/convert/outputs.ts";
import { stubWebp } from "../../src/worker/convert/stub-outputs.ts";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const hasWebpinfo = (() => {
  try {
    execFileSync("webpinfo", ["-version"], { stdio: "ignore" });
    execFileSync("dwebp", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("the stub's WebP is a real image", { timeout: SPAWN_TIMEOUT }, () => {
  it("has the size its header says and differs by salt", () => {
    expect(webpSize(stubWebp(1920, 1080, 1))).toEqual({ w: 1920, h: 1080 });
    expect(Buffer.from(stubWebp(480, 270, 1)).equals(Buffer.from(stubWebp(480, 270, 2)))).toBe(false);
    expect(stubWebp(480, 270, 1).length % 2).toBe(0);
  });

  it.skipIf(!hasWebpinfo)("decodes under libwebp at several sizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "stub-webp-"));
    for (const [w, h, salt] of [
      [1920, 1080, 0],
      [480, 270, 3],
      [3840, 2160, 255],
      [1, 1, 7],
    ] as const) {
      const file = join(dir, `${w}x${h}.webp`);
      writeFileSync(file, stubWebp(w, h, salt));
      const out = execFileSync("webpinfo", [file], { encoding: "utf8" });
      expect(out).toContain(`Width: ${w}`);
      expect(out).toContain(`Height: ${h}`);
      expect(out).toContain("No error detected");
      execFileSync("dwebp", [file, "-o", join(dir, `${w}x${h}.png`)], { stdio: "pipe" });
    }
  });
});
