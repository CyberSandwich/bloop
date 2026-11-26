// The deploy jobs that hold a Cloudflare token do not build: the check job builds dist/ with no token and hands it over
// as an artifact. `wrangler deploy` and `wrangler dev` run wrangler.jsonc `build.command` first, and wrangler 4 has no
// flag that skips it, so the deploy job swaps the command for an assertion that dist/ is there.
//   node tools/prebuilt.mjs rewrite   in the job's checkout, before wrangler runs
//   node tools/prebuilt.mjs assert    the command wrangler then runs
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BUILD = '"build": { "command": "node tools/build-assets-cli.mjs", "watch_dir": "public" }';
const PREBUILT = '"build": { "command": "node tools/prebuilt.mjs assert" }';

/** wrangler.jsonc with the build command replaced; throws when the config no longer has the expected build block.
 * @param {string} config */
export function withPrebuilt(config) {
  if (!config.includes(BUILD)) throw new Error("wrangler.jsonc has no build block this tool knows how to replace");
  return config.replace(BUILD, () => PREBUILT);
}

const command = process.argv[1]?.endsWith("prebuilt.mjs") ? process.argv[2] : undefined;
if (command === "rewrite") {
  writeFileSync("wrangler.jsonc", withPrebuilt(readFileSync("wrangler.jsonc", "utf8")));
} else if (command === "assert") {
  if (!existsSync("dist/index.html")) throw new Error("dist/ is missing: download the build artifact before deploying");
} else if (command) {
  throw new Error("usage: node tools/prebuilt.mjs rewrite|assert");
}
