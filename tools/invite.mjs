// The first admin's invite (ADR 0014): no admin exists yet to create one through /admin, so this prints the D1 command
// that writes it and the link to open. It runs nothing and writes nothing: the token lives only in the printed link.
//   node tools/invite.mjs <email> [--local]
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeEmail } from "../src/worker/auth/email-norm.ts";
import { inviteHash, newInviteToken, UPSERT_INVITE } from "../src/worker/auth/invites.ts";
import { accountVars } from "../src/worker/config/account.ts";
import { newRef } from "../src/worker/ids.ts";
import { wranglerConfig } from "./wrangler-config.mjs";

/** `npm run dev`: its origin and its local D1. */
const LOCAL_ORIGIN = "http://localhost:8787";
const LOCAL_STATE = ".wrangler/state";
const DAY_MS = 86_400_000;
/** What a double-quoted shell argument would expand or end; the normalizer allows them, the printed command cannot. */
const SHELL_SPECIAL = /["$`\\!]/;

/** @param {string | number | null} v */
const literal = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);

/**
 * The command and the link for one address. `now`, `token` and `id` are fixed only by the tests.
 * @param {string} raw
 * @param {{local?: boolean, now?: number, token?: string, id?: string}} [options]
 * @returns {Promise<{command: string, link: string}>}
 */
export async function invite(raw, { local = false, now = Date.now(), token = newInviteToken(), id = newRef() } = {}) {
  const email = normalizeEmail(raw);
  if (!email) throw new Error(`not an address bloop accepts: ${raw}`);
  if (SHELL_SPECIAL.test(email))
    throw new Error("the address holds a character the printed shell command cannot carry");
  const config = wranglerConfig(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const expiresAt = now + accountVars.INVITE_TTL_DAYS.parse(undefined) * DAY_MS;
  /** @type {(string | number | null)[]} */
  const values = [id, await inviteHash(token), email, email, null, null, null, now, expiresAt, now];
  let i = 0;
  const sql = UPSERT_INVITE.replaceAll("?", () => literal(values[i++] ?? null));
  if (i !== values.length) throw new Error(`UPSERT_INVITE has ${i} binds, the tool fills ${values.length}`);
  const database = config.d1_databases[0].database_name;
  const origin = local ? LOCAL_ORIGIN : new URL(config.vars.PUBLIC_ORIGIN).origin;
  return {
    command: `npx wrangler d1 execute ${database} ${local ? `--local --persist-to ${LOCAL_STATE}` : "--remote"} --command "${sql}"`,
    link: `${origin}/invite#t=${token}`,
  };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { local: { type: "boolean" } } });
  if (positionals.length !== 1) {
    console.error("usage: node tools/invite.mjs <email> [--local]");
    process.exit(64);
  }
  try {
    const { command, link } = await invite(positionals[0] ?? "", { local: values.local === true });
    console.log(command);
    console.log(link);
  } catch (e) {
    console.error(`invite: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
