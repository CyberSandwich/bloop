// Moderation's account actions (docs/adr/0013-data-model.md). The block list is the one check every path that could
// bring a closed or banned address back runs: code sign-in, restore, invite acceptance.
import { type Db, dbOf } from "../auth/db.ts";
import { hmacHex } from "../ids.ts";

/**
 * Whether the address is on the block list. The table holds only `v1:` + HMAC(CODE_PEPPER, email_norm), never the
 * address. Without the pepper no row can be checked, so every address reads as blocked.
 */
export async function isBlocked(db: Db, pepper: string | null, emailNorm: string): Promise<boolean> {
  if (!pepper) return true;
  const row = await db
    .prepare("SELECT 1 AS hit FROM email_block WHERE email_hash = ?")
    .bind(`v1:${await hmacHex(pepper, emailNorm)}`)
    .first<{ hit: number }>();
  return row !== null;
}

/** The block list as the routes take it, so a test can stand in for it. */
export type BlockCheck = (env: { DB: unknown }, pepper: string | null, emailNorm: string) => Promise<boolean>;

export const blockCheck: BlockCheck = (env, pepper, emailNorm) => isBlocked(dbOf(env.DB), pepper, emailNorm);
