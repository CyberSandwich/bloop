// The staging deploy's steps (.github/workflows/staging.yml, docs/setup.md "Staging"). The pure helpers are unit
// tested; `ready` and `deploy` run in the workflow only and never print a secret value.
//   ready    prints one line and sets `ready=true|false`: false (a clean skip) until the staging D1 exists. The buckets
//            are not probed: a missing one fails the deploy, and the token then needs no R2 permission.
//   deploy   writes the D1 id (STAGING_D1_ID in the environment) into wrangler.jsonc for this job's checkout, applies
//            the migrations, deploys, then sets every missing staging secret from a random value that is piped in
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const D1_NAME = "bloop-staging";
export const PLACEHOLDER = "STAGING_D1_ID";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const b64url = () => randomBytes(32).toString("base64url");
/** Every staging secret and how its value is made; ADMIN_EMAILS and TEST_EMAILS are addresses, set by hand. */
/** @type {Record<string, () => string>} */
export const SECRETS = {
  COOKIE_KEY: () => randomBytes(32).toString("base64"),
  HASH_PEPPER: b64url,
  CODE_PEPPER: b64url,
  FILE_TOKEN_KEY: b64url,
  IT_EXPORT_TOKEN: b64url,
  TALLY_SIGNING_SECRET: b64url,
  TOKEN_KEKS: () => JSON.stringify({ k1: randomBytes(32).toString("base64") }),
};

/** The id of the database named `name` in `wrangler d1 list --json`, or null.
 * @param {string} listJson @param {string} [name] */
export function d1IdFrom(listJson, name = D1_NAME) {
  const list = /** @type {{ name: string, uuid: string }[]} */ (JSON.parse(listJson));
  return list.find((d) => d.name === name)?.uuid ?? null;
}

/** The staging secrets `wrangler secret list --format json` does not show yet.
 * @param {string} listJson */
export function missingSecrets(listJson) {
  const have = new Set(/** @type {{ name: string }[]} */ (JSON.parse(listJson)).map((s) => s.name));
  return Object.keys(SECRETS).filter((name) => !have.has(name));
}

/** wrangler.jsonc with the staging D1 id in place of the placeholder; throws when the placeholder is gone.
 * @param {string} config @param {string} id */
export function withD1Id(config, id) {
  const slot = `"database_id": "${PLACEHOLDER}"`;
  if (!config.includes(slot)) throw new Error(`${PLACEHOLDER} is not in the config`);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("the D1 id is not a UUID");
  return config.replace(slot, () => `"database_id": "${id}"`);
}

/** The wrangler version package-lock.json pins.
 * @param {string} lockJson */
export function lockedWranglerVersion(lockJson) {
  const version = JSON.parse(lockJson).packages?.["node_modules/wrangler"]?.version;
  if (typeof version !== "string") throw new Error("package-lock.json does not pin wrangler");
  return version;
}

/**
 * The installed wrangler's entry file, by absolute path. `npm ci --ignore-scripts` has checked the tarball against the
 * lockfile's integrity hash; this refuses a node_modules that holds another version, so the token reaches the pinned
 * wrangler and never a package found on PATH. No test runner or linter shares the job.
 * @param {string} root
 */
export function wranglerEntry(root = ROOT) {
  const installed = JSON.parse(readFileSync(join(root, "node_modules/wrangler/package.json"), "utf8")).version;
  const pinned = lockedWranglerVersion(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (installed !== pinned) throw new Error(`wrangler ${installed} is installed but the lockfile pins ${pinned}`);
  return join(root, "node_modules/wrangler/bin/wrangler.js");
}

/** @param {string[]} args @param {string} [input] */
const wrangler = (args, input) =>
  spawnSync(process.execPath, [wranglerEntry(), ...args], { encoding: "utf8", input, env: process.env });

/**
 * A failed wrangler call (a bad token, an outage) fails the job; it never reads as "not found".
 * @param {string[]} args
 */
function wranglerOk(args) {
  const run = wrangler(args);
  if (run.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed: ${run.stderr}`);
  return run.stdout;
}

function ready() {
  const out = process.env.GITHUB_OUTPUT;
  const id = d1IdFrom(wranglerOk(["d1", "list", "--json"]));
  if (!id) {
    console.log(
      `Staging skipped: D1 database ${D1_NAME} not found. Create the staging resources (docs/setup.md, Staging) and rerun.`,
    );
    if (out) appendFileSync(out, "ready=false\n");
    return;
  }
  console.log("Staging resources found.");
  if (out) appendFileSync(out, `ready=true\nd1_id=${id}\n`);
}

function deploy() {
  const file = "wrangler.jsonc";
  writeFileSync(file, withD1Id(readFileSync(file, "utf8"), process.env.STAGING_D1_ID ?? ""));
  wranglerOk(["d1", "migrations", "apply", "DB", "--remote", "-e", "staging"]);
  wranglerOk(["deploy", "-e", "staging"]);
  for (const name of missingSecrets(wranglerOk(["secret", "list", "-e", "staging", "--format", "json"]))) {
    const put = wrangler(["secret", "put", name, "-e", "staging"], SECRETS[name]?.());
    if (put.status !== 0) throw new Error(`could not set ${name}`);
    console.log(`Set staging secret ${name}.`);
  }
}

const command = process.argv[1]?.endsWith("staging.mjs") ? process.argv[2] : undefined;
if (command === "ready") ready();
else if (command === "deploy") deploy();
else if (command) throw new Error("usage: node tools/staging.mjs ready|deploy");
