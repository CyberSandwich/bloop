// A member's passkeys (ADR 0014): the account page's list, rename and remove, and the age the admin step-up reads.
// Every statement is scoped by user_id, so one member can never name another's credential.
import type { Db } from "./db.ts";

export interface PasskeyEntry {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

export async function listPasskeys(db: Db, userId: string): Promise<PasskeyEntry[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name, created_at, last_used_at, backed_up FROM passkey WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null; backed_up: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    backedUp: r.backed_up === 1,
  }));
}

/** False when the user has no passkey with this id. */
export async function renamePasskey(db: Db, userId: string, id: string, name: string): Promise<boolean> {
  const res = await db.prepare("UPDATE passkey SET name = ? WHERE id = ? AND user_id = ?").bind(name, id, userId).run();
  return res.meta.changes === 1;
}

/** False when the user has no passkey with this id. */
export async function deletePasskey(db: Db, userId: string, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM passkey WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return res.meta.changes === 1;
}

/** When the user's passkey was registered, or null when it is not theirs or is gone. */
export async function passkeyCreatedAt(db: Db, userId: string, id: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT created_at FROM passkey WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ created_at: number }>();
  return row?.created_at ?? null;
}
