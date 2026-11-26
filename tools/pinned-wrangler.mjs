// Runs the wrangler that package-lock.json pins, by absolute path, in the deploy jobs that hold a Cloudflare token
// (.github/workflows/deploy.yml and staging.yml). `npm ci --ignore-scripts` has checked each tarball against the
// lockfile's integrity hash; this refuses a node_modules that holds another wrangler version, so the token reaches the
// pinned wrangler and never a package found on PATH.
//   node tools/pinned-wrangler.mjs <wrangler arguments>
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requirePrebuilt } from "./prebuilt.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The wrangler version package-lock.json pins.
 * @param {string} lockJson */
export function lockedWranglerVersion(lockJson) {
  const version = JSON.parse(lockJson).packages?.["node_modules/wrangler"]?.version;
  if (typeof version !== "string") throw new Error("package-lock.json does not pin wrangler");
  return version;
}

/** The installed wrangler's entry file, by absolute path.
 * @param {string} root */
export function wranglerEntry(root = ROOT) {
  const installed = JSON.parse(readFileSync(join(root, "node_modules/wrangler/package.json"), "utf8")).version;
  const pinned = lockedWranglerVersion(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (installed !== pinned) throw new Error(`wrangler ${installed} is installed but the lockfile pins ${pinned}`);
  return join(root, "node_modules/wrangler/bin/wrangler.js");
}

/** The arguments that make wrangler read wrangler.jsonc and nothing else; put them before the caller's own. Throws when
 * another config could be found first (wrangler picks up wrangler.json, wrangler.toml and a redirect file by itself),
 * the caller names one (`-c`, `-cX`, `--config`), or passes `--`, after which flags are not flags.
 * @param {string[]} args @param {string} root */
export function configArgs(args, root = ROOT) {
  const named = args.find((arg) => /^-c/.test(arg) || arg === "--" || arg.startsWith("--config"));
  if (named) throw new Error(`${named}: the config is wrangler.jsonc, set by this tool`);
  for (const dir of new Set([root, process.cwd()])) {
    for (const stray of ["wrangler.json", "wrangler.toml", ".wrangler/deploy/config.json"]) {
      if (existsSync(join(dir, stray))) throw new Error(`${join(dir, stray)} would replace wrangler.jsonc`);
    }
  }
  return ["--config", join(root, "wrangler.jsonc")];
}

/** Whether the environment holds a Cloudflare credential wrangler reads.
 * @param {NodeJS.ProcessEnv} env */
export const holdsToken = (env) => ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY"].some((k) => env[k]);

/** The commands that never run wrangler.jsonc's build command. Everything else, including a command added later, is
 * treated as one that does. `containers` only drives docker and the registry API: in the pinned wrangler's
 * wrangler-dist/cli.js no containers handler reaches getEntry, the one caller of runCustomBuild (deploy, dev, types,
 * versions and preview do). Re-check that on a wrangler upgrade. */
const NEVER_BUILDS = ["d1", "secret", "whoami", "kv", "r2", "deployments", "tail", "containers"];

/** Whether a wrangler command may run the build command: true unless its first argument is on the safe list, so a
 * leading flag or flag value (`-e d1 deploy`) fails closed.
 * @param {string[]} args */
export const mayBuild = (args) => !NEVER_BUILDS.includes(args[0] ?? "");

if (process.argv[1]?.endsWith("pinned-wrangler.mjs")) {
  const args = process.argv.slice(2);
  const token = holdsToken(process.env);
  // With the token, wrangler.jsonc's build command (third-party code) must not run.
  if (token && mayBuild(args)) requirePrebuilt(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const run = spawnSync(process.execPath, [wranglerEntry(), ...(token ? configArgs(args) : []), ...args], {
    stdio: "inherit",
  });
  process.exit(run.status ?? 1);
}
