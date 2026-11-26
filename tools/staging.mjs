// The staging deploy's steps (.github/workflows/staging.yml, docs/setup.md "Staging"). The pure helpers are unit
// tested; `ready`, `prepare` and `secrets` run in the workflow only and never print a secret value.
//   ready    prints one line and sets `ready=true|false`: false (a clean skip) until every staging resource exists
//   prepare  writes the D1 id (STAGING_D1_ID in the environment) into wrangler.jsonc for this job's checkout
//   secrets  sets every missing staging secret from a random value that is piped in, never shown
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export const D1_NAME = "bloop-staging";
export const BUCKETS = ["bloop-staging-guest", "bloop-staging-library"];
export const PLACEHOLDER = "STAGING_D1_ID";

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

/** @param {string[]} args @param {string} [input] */
const wrangler = (args, input) =>
  spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", input, env: process.env });

function ready() {
  const out = process.env.GITHUB_OUTPUT;
  const skip = (/** @type {string} */ why) => {
    console.log(`Staging skipped: ${why}. Create the staging resources (docs/setup.md, Staging) and rerun.`);
    if (out) appendFileSync(out, "ready=false\n");
  };
  const list = wrangler(["d1", "list", "--json"]);
  const id = list.status === 0 ? d1IdFrom(list.stdout) : null;
  if (!id) return skip(`D1 database ${D1_NAME} not found`);
  for (const bucket of BUCKETS) {
    if (wrangler(["r2", "bucket", "info", bucket, "--jurisdiction", "eu"]).status !== 0) {
      return skip(`R2 bucket ${bucket} not found or not readable`);
    }
  }
  console.log("Staging resources found.");
  if (out) appendFileSync(out, `ready=true\nd1_id=${id}\n`);
}

function prepare() {
  const file = "wrangler.jsonc";
  writeFileSync(file, withD1Id(readFileSync(file, "utf8"), process.env.STAGING_D1_ID ?? ""));
}

function secrets() {
  const list = wrangler(["secret", "list", "-e", "staging", "--format", "json"]);
  const missing = list.status === 0 ? missingSecrets(list.stdout) : Object.keys(SECRETS);
  for (const name of missing) {
    const put = wrangler(["secret", "put", name, "-e", "staging"], SECRETS[name]?.());
    if (put.status !== 0) throw new Error(`could not set ${name}`);
    console.log(`Set staging secret ${name}.`);
  }
  if (missing.length === 0) console.log("Every staging secret is set.");
}

const command = process.argv[1]?.endsWith("staging.mjs") ? process.argv[2] : undefined;
if (command === "ready") ready();
else if (command === "prepare") prepare();
else if (command === "secrets") secrets();
else if (command) throw new Error("usage: node tools/staging.mjs ready|prepare|secrets");
