// The deploy jobs that hold a Cloudflare token do not build: the check job builds dist/ with no token and hands it over
// as an artifact. `wrangler deploy` and `wrangler dev` run wrangler.jsonc `build.command` first, and wrangler 4 has no
// flag that skips it, so the deploy job swaps the command for an assertion that dist/ is what the check job built.
// Imports nothing third-party: it runs in the job that holds the token.
//   node tools/prebuilt.mjs manifest  in the check job, after the build: dist/.build-manifest.json, every file's hash
//   node tools/prebuilt.mjs rewrite   in the deploy job's checkout, before wrangler runs
//   node tools/prebuilt.mjs assert    the command wrangler then runs: dist/ equals its manifest, dotfiles included
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const BUILD = '"build": { "command": "node tools/build-assets-cli.mjs", "watch_dir": "public" }';
const PREBUILT = '"build": { "command": "node tools/prebuilt.mjs assert" }';
export const MANIFEST = ".build-manifest.json";

/** wrangler.jsonc with the build command replaced; throws when the config no longer has the expected build block.
 * @param {string} config */
export function withPrebuilt(config) {
  if (!config.includes(BUILD)) throw new Error("wrangler.jsonc has no build block this tool knows how to replace");
  return config.replace(BUILD, () => PREBUILT);
}

/** Every file under dir, dotfiles included, with its SHA-256; the manifest itself is not listed.
 * @param {string} dir @returns {Record<string, string>} */
export function filesOf(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel !== MANIFEST)
      files[rel] = createHash("sha256")
        .update(readFileSync(join(dir, rel)))
        .digest("hex");
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** What differs between dist/ and its manifest: a file missing, extra or changed.
 * @param {string} dir @returns {string[]} */
export function manifestProblems(dir) {
  if (!existsSync(join(dir, MANIFEST))) return [`${MANIFEST} is missing`];
  const expected = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const actual = filesOf(dir);
  return [
    ...Object.keys(expected)
      .filter((rel) => !(rel in actual))
      .map((rel) => `${rel} is missing`),
    ...Object.keys(actual)
      .filter((rel) => !(rel in expected))
      .map((rel) => `${rel} is not in the manifest`),
    ...Object.keys(actual)
      .filter((rel) => rel in expected && expected[rel] !== actual[rel])
      .map((rel) => `${rel} changed`),
  ];
}

const command = process.argv[1]?.endsWith("prebuilt.mjs") ? process.argv[2] : undefined;
if (command === "manifest") {
  writeFileSync(join("dist", MANIFEST), `${JSON.stringify(filesOf("dist"), null, 1)}\n`);
} else if (command === "rewrite") {
  writeFileSync("wrangler.jsonc", withPrebuilt(readFileSync("wrangler.jsonc", "utf8")));
} else if (command === "assert") {
  const problems = manifestProblems("dist");
  if (problems.length > 0) throw new Error(`dist/ is not the check job's build: ${problems.join("; ")}`);
} else if (command) {
  throw new Error("usage: node tools/prebuilt.mjs manifest|rewrite|assert");
}
