import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withPrebuilt } from "../../tools/prebuilt.mjs";
import { SECRETS } from "../../tools/staging.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const PREBUILT_TEXT = '"build": { "command": "node tools/prebuilt.mjs assert" }';
const D1_ID = "11111111-2222-3333-4444-555555555555";

// A wrangler that records every call and fails the ones named in FAIL, so the CLI can be run without a network.
const FAKE_WRANGLER = `
const { appendFileSync, readFileSync } = require("node:fs");
const raw = process.argv.slice(2);
const at = raw.indexOf("--config");
const args = (at < 0 ? raw : raw.slice(0, at)).join(" ");
appendFileSync(process.env.CALLS, args + "\\n");
appendFileSync(process.env.CALLS + ".config", (at < 0 ? "none" : raw[at + 1]) + "\\n");
appendFileSync(process.env.CALLS + ".token", (process.env.CLOUDFLARE_API_TOKEN ?? "missing") + "\\n");
if ((process.env.FAIL ?? "").split(",").some((prefix) => prefix && args.startsWith(prefix))) {
  console.error("fake wrangler: refused " + args);
  process.exit(1);
}
if (args.startsWith("d1 list")) console.log(JSON.stringify([{ name: "bloop-staging", uuid: "${D1_ID}" }]));
if (args.startsWith("secret list")) console.log("[]");
if (args.startsWith("secret put")) readFileSync(0);
`;

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A copy of the CLI's own folder layout with a fake wrangler the lockfile pins, so ROOT resolves into the temp dir. */
function project(swapped = true) {
  root = mkdtempSync(join(tmpdir(), "bloop-staging-cli-"));
  mkdirSync(join(root, "tools"));
  for (const file of ["staging.mjs", "pinned-wrangler.mjs", "prebuilt.mjs", "wrangler-config.mjs"]) {
    copyFileSync(join(REPO, "tools", file), join(root, "tools", file));
  }
  mkdirSync(join(root, "node_modules/wrangler/bin"), { recursive: true });
  writeFileSync(join(root, "node_modules/wrangler/package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(root, "node_modules/wrangler/bin/wrangler.js"), FAKE_WRANGLER);
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: { "node_modules/wrangler": { version: "9.9.9" } },
    }),
  );
  const config = readFileSync(join(REPO, "wrangler.jsonc"), "utf8");
  // The prebuilt-dist action has already swapped the build command when the staging step runs.
  writeFileSync(join(root, "wrangler.jsonc"), swapped ? withPrebuilt(config) : config);
  return join(root, "calls.log");
}

function run(command: string, env: Record<string, string>, swapped = true) {
  const calls = project(swapped);
  writeFileSync(calls, "");
  writeFileSync(`${calls}.token`, "");
  writeFileSync(`${calls}.config`, "");
  const result = spawnSync(process.execPath, [join(root, "tools/staging.mjs"), command], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CALLS: calls,
      STAGING_D1_ID: D1_ID,
      CLOUDFLARE_API_TOKEN: "token-under-test",
      ...env,
    },
  });
  const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
  return { ...result, calls: lines(calls), tokens: lines(`${calls}.token`), configs: lines(`${calls}.config`) };
}

describe("tools/staging.mjs as the workflow runs it", () => {
  it("ready: a failed `d1 list` fails the job with no output flag, and nothing else is called", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const output = join(tmpdir(), `bloop-gh-output-${process.pid}`);
    writeFileSync(output, "");
    const res = run("ready", { FAIL: "d1 list", GITHUB_OUTPUT: output });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("wrangler d1 list failed");
    expect(readFileSync(output, "utf8")).toBe("");
    expect(res.calls).toEqual(["d1 list --json"]);
    rmSync(output);
  });

  it("ready: finds the database and writes its id for the next step", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const output = join(tmpdir(), `bloop-gh-output-ok-${process.pid}`);
    writeFileSync(output, "");
    const res = run("ready", { GITHUB_OUTPUT: output });
    expect(res.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`ready=true\nd1_id=${D1_ID}\n`);
    rmSync(output);
  });

  it("deploy: a failed `secret list` fails the job and no secret is written", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const res = run("deploy", { FAIL: "secret list" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("wrangler secret list failed");
    expect(res.calls.some((call) => call.startsWith("secret put"))).toBe(false);
  });

  it("deploy: a failed deploy stops before the secrets are read or written", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const res = run("deploy", { FAIL: "deploy" });
    expect(res.status).not.toBe(0);
    expect(res.calls.some((call) => call.startsWith("secret"))).toBe(false);
  });

  it("deploy: migrates, deploys, then sets every missing secret exactly once, never printing one", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const res = run("deploy", {});
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls.slice(0, 2)).toEqual(["d1 migrations apply DB --remote -e staging", "deploy -e staging"]);
    const puts = res.calls.filter((call) => call.startsWith("secret put")).map((call) => call.split(" ")[2]);
    expect(puts.sort()).toEqual(Object.keys(SECRETS).sort());
    expect(res.stdout).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect(res.stdout + res.stderr).not.toContain("token-under-test");
    // Every call is the pinned wrangler, and each one carries the token through the environment, never an argument.
    expect(res.tokens).toEqual(res.calls.map(() => "token-under-test"));
    expect(res.calls.every((call) => !call.includes("token-under-test"))).toBe(true);
    // Each call names wrangler.jsonc itself, so no other config file can stand in for it.
    expect(res.configs).toEqual(res.calls.map(() => join(realpathSync(root), "wrangler.jsonc")));
    const config = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    expect(config).toContain(`"database_id": "${D1_ID}"`);
    expect(config).toContain("node tools/prebuilt.mjs assert");
  });

  it("deploy: refuses to run while wrangler.jsonc still has the real build command", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const res = run("deploy", {}, false);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("still builds");
    expect(res.calls).toEqual([]);
  });

  it("pinned-wrangler: a deploy with the token needs the swapped build command, and one without it passes through", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const calls = project(false);
    writeFileSync(calls, "");
    writeFileSync(`${calls}.token`, "");
    const wrangler = (token: string, ...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(root, "tools/pinned-wrangler.mjs"), ...(args.length ? args : ["deploy", "--dry-run"])],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, CALLS: calls, CLOUDFLARE_API_TOKEN: token },
        },
      );
    for (const args of [
      ["deploy", "--dry-run"],
      ["-e", "staging", "deploy"],
      ["versions", "upload"],
      ["versions", "deploy"],
      ["dev"],
      ["types"],
      ["preview"],
      ["some-future-command"],
    ]) {
      const refused = wrangler("token-under-test", ...args);
      expect(refused.status, args.join(" ")).not.toBe(0);
      expect(refused.stderr, args.join(" ")).toContain("still builds");
    }
    // The swapped text alone is not enough while the real build block is still there.
    const config = join(root, "wrangler.jsonc");
    writeFileSync(config, `// ${PREBUILT_TEXT}\n${readFileSync(config, "utf8")}`);
    expect(wrangler("token-under-test").status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("");
    // Commands that build and ship nothing work with the token on an unswapped config, as an owner's local one does.
    expect(wrangler("token-under-test", "secret", "put", "X").status).toBe(0);
    expect(wrangler("token-under-test", "d1", "migrations", "apply", "DB").status).toBe(0);
    for (const command of ["whoami", "kv", "r2"]) expect(wrangler("token-under-test", command).status).toBe(0);
    // The other credential variables count as a token too.
    for (const name of ["CF_API_TOKEN", "CLOUDFLARE_API_KEY"]) {
      const res = spawnSync(process.execPath, [join(root, "tools/pinned-wrangler.mjs"), "deploy"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CALLS: calls, CLOUDFLARE_API_TOKEN: "", [name]: "token-under-test" },
      });
      expect(res.stderr, name).toContain("still builds");
    }
    // The rehearsal has no token: wrangler itself runs the build command, which is the point of the dry run.
    expect(wrangler("").status).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe(
      "secret put X\nd1 migrations apply DB\nwhoami\nkv\nr2\ndeploy --dry-run\n",
    );
  });

  it("pinned-wrangler: an environment's own build command, or extra build keys, are refused too", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const calls = project();
    const config = join(root, "wrangler.jsonc");
    const swapped = readFileSync(config, "utf8");
    const bad = [
      swapped.replace('"staging": {', '"staging": {\n    "build": { "command": "npx evil" },'),
      swapped.replace(
        '"command": "node tools/prebuilt.mjs assert"',
        '"command": "node tools/prebuilt.mjs assert", "cwd": "dist"',
      ),
    ];
    for (const text of bad) {
      expect(text).not.toBe(swapped);
      writeFileSync(config, text);
      const res = spawnSync(process.execPath, [join(root, "tools/pinned-wrangler.mjs"), "deploy"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CALLS: calls, CLOUDFLARE_API_TOKEN: "token-under-test" },
      });
      expect(res.stderr).toContain("still builds");
    }
  });

  it("with the token, a stray wrangler config or a named --config is refused in both tools, and the config is passed explicitly", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const calls = project();
    writeFileSync(calls, "");
    const spawn = (tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [join(root, "tools", tool), ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CALLS: calls, CLOUDFLARE_API_TOKEN: "token-under-test", STAGING_D1_ID: D1_ID },
      });
    const named = spawn("pinned-wrangler.mjs", "d1", "list", "--config", "other.jsonc");
    expect(named.status).not.toBe(0);
    expect(named.stderr).toContain("the config is wrangler.jsonc");
    expect(spawn("pinned-wrangler.mjs", "d1", "list", "-c", "other.jsonc").status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("");
    for (const stray of ["wrangler.json", "wrangler.toml", ".wrangler/deploy/config.json"]) {
      mkdirSync(join(root, stray, ".."), { recursive: true });
      writeFileSync(join(root, stray), "{}");
      for (const res of [spawn("pinned-wrangler.mjs", "d1", "list"), spawn("staging.mjs", "ready")]) {
        expect(res.status, stray).not.toBe(0);
        expect(res.stderr, stray).toContain("would replace wrangler.jsonc");
      }
      rmSync(join(root, stray));
    }
    expect(readFileSync(calls, "utf8")).toBe("");
    expect(spawn("pinned-wrangler.mjs", "d1", "list").status).toBe(0);
    expect(readFileSync(`${calls}.config`, "utf8")).toBe(`${join(realpathSync(root), "wrangler.jsonc")}\n`);
  });

  it("refuses a wrangler that is not the version the lockfile pins", {
    timeout: SPAWN_TIMEOUT,
  }, () => {
    const calls = project();
    writeFileSync(join(root, "node_modules/wrangler/package.json"), JSON.stringify({ version: "1.0.0" }));
    const res = spawnSync(process.execPath, [join(root, "tools/staging.mjs"), "ready"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CALLS: calls },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("the lockfile pins 9.9.9");
  });
});
