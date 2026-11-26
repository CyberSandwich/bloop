// The integration harness's `limits` option: which dev vars file the derived config reads, and what it refuses.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devVarsArgs, startWrangler } from "../integration/wrangler.ts";

const dirs: string[] = [];
const dir = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), "bloop-devvars-"));
  dirs.push(d);
  for (const f of files) writeFileSync(join(d, f), "X=1\n");
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("startWrangler limits", () => {
  it("points the derived config at the repo's .dev.vars, else its .env and .env.local, read in place", () => {
    const both = dir([".dev.vars", ".env", ".env.local"]);
    expect(devVarsArgs(both)).toEqual(["--env-file", join(both, ".dev.vars")]);
    const env = dir([".env", ".env.local"]);
    expect(devVarsArgs(env)).toEqual(["--env-file", join(env, ".env"), "--env-file", join(env, ".env.local")]);
    const local = dir([".env.local"]);
    expect(devVarsArgs(local)).toEqual(["--env-file", join(local, ".env.local")]);
    expect(devVarsArgs(dir([]))).toEqual([]);
  });

  it.each([
    [{ RL_NOPE: 5 }, "no one-line production ratelimits entry for RL_NOPE"],
    [{ RL_MEMBER_IP: 0 }, "a limit is a positive integer"],
    [{ RL_MEMBER_IP: 2.5 }, "a limit is a positive integer"],
  ])("refuses %o before starting anything", async (limits, message) => {
    await expect(startWrangler({}, { limits })).rejects.toThrow(message);
  });

  it("refuses limits together with another config", async () => {
    await expect(startWrangler({}, { config: "x.jsonc", limits: { RL_MEMBER_IP: 5 } })).rejects.toThrow(
      "limits applies to wrangler.jsonc",
    );
  });
});
