// Runs the wrangler that package-lock.json pins, by absolute path, in the deploy jobs that hold a Cloudflare token
// (.github/workflows/deploy.yml and staging.yml). `npm ci --ignore-scripts` has checked each tarball against the
// lockfile's integrity hash; this refuses a node_modules that holds another wrangler version, so the token reaches the
// pinned wrangler and never a package found on PATH.
//   node tools/pinned-wrangler.mjs <wrangler arguments>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

if (process.argv[1]?.endsWith("pinned-wrangler.mjs")) {
  const run = spawnSync(process.execPath, [wranglerEntry(), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
