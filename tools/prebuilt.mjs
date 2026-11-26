// The deploy jobs that hold a Cloudflare token do not build: the check job builds dist/ with no token and hands it over
// as an artifact. `wrangler deploy` and `wrangler dev` run wrangler.jsonc `build.command` first, and wrangler 4 has no
// flag that skips it, so the deploy job swaps the command for an assertion that dist/ is what the check job built.
// Imports nothing third-party: it runs in the job that holds the token.
//   node tools/prebuilt.mjs manifest  in the check job, after the build: dist/.build-manifest.json, every file's hash
//   node tools/prebuilt.mjs rewrite   in the deploy job's checkout, before wrangler runs: the build command, and the
//                                     account id (CLOUDFLARE_ACCOUNT_ID) and the digest (container/digest.txt) in the
//                                     converter image reference
//   node tools/prebuilt.mjs assert    the command wrangler then runs: dist/ equals its manifest, dotfiles included
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wranglerConfig } from "./wrangler-config.mjs";

const BUILD = '"build": { "command": "node tools/build-assets-cli.mjs", "watch_dir": "public" }';
const PREBUILT = '"build": { "command": "node tools/prebuilt.mjs assert" }';
export const MANIFEST = ".build-manifest.json";

/** wrangler.jsonc with the build command replaced; throws when the config no longer has the expected build block.
 * @param {string} config */
export function withPrebuilt(config) {
  if (!config.includes(BUILD)) throw new Error("wrangler.jsonc has no build block this tool knows how to replace");
  return config.replace(BUILD, () => PREBUILT);
}

/** wrangler checks the image reference's shape wherever it loads the config (dev, tests), so the repo's placeholders are
 * all zeros in the exact shape: no account has that id and no image that digest. */
const NO_ACCOUNT = "0".repeat(32);
const NO_DIGEST = `sha256:${"0".repeat(64)}`;
const IMAGE = (/** @type {string} */ account, /** @type {string} */ digest) =>
  `registry.cloudflare.com/${account}/bloop-converter@${digest}`;

/**
 * wrangler.jsonc with the converter image reference filled in (CONV-06): the account id comes from the environment, so
 * the repo never holds it (without one, as in the CI rehearsal, it stays the zeros), and the digest from
 * container/digest.txt, the one place a pin is written.
 * @param {string} config @param {string | undefined} accountId @param {string} digest "sha256:<64 hex>"
 */
export function withImage(config, accountId, digest) {
  if (accountId !== undefined && !/^[0-9a-f]{32}$/.test(accountId))
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not a 32-character hex account id");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || digest === NO_DIGEST)
    throw new Error("container/digest.txt is not a sha256 digest");
  return config.replaceAll(IMAGE(NO_ACCOUNT, NO_DIGEST), IMAGE(accountId ?? NO_ACCOUNT, digest));
}

/** Throws unless the parsed top-level build block, and any environment's, is exactly the assertion, so a deploy run in
 * the wrong order fails closed instead of building in the job that holds the token.
 * @param {string} config */
export function requirePrebuilt(config) {
  const assertion = JSON.stringify({ command: "node tools/prebuilt.mjs assert" });
  const parsed = wranglerConfig(config);
  const envs = Object.values(parsed.env ?? {});
  const swapped =
    JSON.stringify(parsed.build) === assertion &&
    envs.every((env) => env.build === undefined || JSON.stringify(env.build) === assertion);
  if (!swapped || config.includes(BUILD))
    throw new Error("wrangler.jsonc still builds: run tools/prebuilt.mjs rewrite first");
  if (config.includes(NO_DIGEST))
    throw new Error("wrangler.jsonc still has the image placeholder: run tools/prebuilt.mjs rewrite first");
}

/** Every file under dir, dotfiles included, with its SHA-256; the manifest itself is not listed. Anything that is not
 * a plain file or folder (a symlink above all) throws: a link could publish a file from outside dist/. The result has
 * no prototype, so a file named __proto__ is an ordinary key.
 * @param {string} dir @returns {Record<string, string>} */
export function filesOf(dir) {
  /** @type {Record<string, string>} */
  const found = Object.create(null);
  /** @param {string} rel */
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else if (!stat.isFile()) throw new Error(`${dir}/${path} is not a plain file or folder`);
      else if (path !== MANIFEST)
        found[path] = createHash("sha256")
          .update(readFileSync(join(dir, path)))
          .digest("hex");
    }
  };
  walk("");
  /** @type {Record<string, string>} */
  const files = Object.create(null);
  for (const path of Object.keys(found).sort()) files[path] = found[path] ?? "";
  return files;
}

/** What differs between dist/ and its manifest: a file missing, extra or changed.
 * @param {string} dir @returns {string[]} */
export function manifestProblems(dir) {
  if (!existsSync(join(dir, MANIFEST))) return [`${MANIFEST} is missing`];
  const expected = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const actual = filesOf(dir);
  const has = (/** @type {object} */ files, /** @type {string} */ rel) => Object.hasOwn(files, rel);
  return [
    ...Object.keys(expected)
      .filter((rel) => !has(actual, rel))
      .map((rel) => `${rel} is missing`),
    ...Object.keys(actual)
      .filter((rel) => !has(expected, rel))
      .map((rel) => `${rel} is not in the manifest`),
    ...Object.keys(actual)
      .filter((rel) => has(expected, rel) && expected[rel] !== actual[rel])
      .map((rel) => `${rel} changed`),
  ];
}

const command = process.argv[1]?.endsWith("prebuilt.mjs") ? process.argv[2] : undefined;
if (command === "manifest") {
  writeFileSync(join("dist", MANIFEST), `${JSON.stringify(filesOf("dist"), null, 1)}\n`);
} else if (command === "rewrite") {
  writeFileSync(
    "wrangler.jsonc",
    withImage(
      withPrebuilt(readFileSync("wrangler.jsonc", "utf8")),
      process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
      readFileSync("container/digest.txt", "utf8").trim(),
    ),
  );
} else if (command === "assert") {
  const problems = manifestProblems("dist");
  if (problems.length > 0) throw new Error(`dist/ is not the check job's build: ${problems.join("; ")}`);
} else if (command) {
  throw new Error("usage: node tools/prebuilt.mjs manifest|rewrite|assert");
}
