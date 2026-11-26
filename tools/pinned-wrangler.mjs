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

/** The arguments that make wrangler read wrangler.jsonc and nothing else. Throws when another config could be found
 * first (wrangler picks up wrangler.json, wrangler.toml and a redirect file by itself), or the caller names one.
 * @param {string[]} args @param {string} root */
export function configArgs(args, root = ROOT) {
  const named = args.find((arg) => arg === "-c" || arg === "--config" || arg.startsWith("--config="));
  if (named) throw new Error(`${named}: the config is wrangler.jsonc, set by this tool`);
  for (const dir of new Set([root, process.cwd()])) {
    for (const stray of ["wrangler.json", "wrangler.toml", ".wrangler/deploy/config.json"]) {
      if (existsSync(join(dir, stray))) throw new Error(`${join(dir, stray)} would replace wrangler.jsonc`);
    }
  }
  return ["--config", join(root, "wrangler.jsonc")];
}

if (process.argv[1]?.endsWith("pinned-wrangler.mjs")) {
  const args = process.argv.slice(2);
  const token = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  // A command that builds or ships code must not run wrangler.jsonc's build command (third-party code) with the token.
  // Any word match, so a flag before the subcommand (`-e staging deploy`) cannot hide it.
  const ships = args.some((arg) => ["deploy", "dev", "versions", "upload"].includes(arg));
  if (ships && token) requirePrebuilt(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const run = spawnSync(process.execPath, [wranglerEntry(), ...args, ...(token ? configArgs(args) : [])], {
    stdio: "inherit",
  });
  process.exit(run.status ?? 1);
}
