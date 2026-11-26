// The Sample Deck: the demo's deck copied into a member's library as an ordinary ready file whose preparation is queued
// like any upload's (docs/ux/library.md, empty state). The quota and the file cap are checked in the same statement that
// inserts the row, so two taps at once cannot overfill either.
import { crc32 } from "../crc32.ts";
import { bucketOf } from "./bucket.ts";
import { filePrefix } from "./purge.ts";
import { libDbOf } from "./store.ts";

export const SAMPLE_NAME = "Deck.pptx";

export type SampleOutcome = { ok: true; id: string } | { ok: false; error: "quota_exceeded" | "library_full" };

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

// transitional: U: U's settle builders (the quota check and the library_file and derived inserts) replace this
export async function addSample(
  env: { DB: unknown; LIBRARY: unknown },
  userId: string,
  deck: Uint8Array<ArrayBuffer>,
  limits: { quotaBytes: number; maxFiles: number },
  id: string,
  now: number,
): Promise<SampleOutcome> {
  const db = libDbOf(env.DB);
  const bucket = bucketOf(env.LIBRARY);
  const key = `${filePrefix(userId, id)}v1/orig`;
  await bucket.put(key, deck);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", deck));
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO library_file (id, user_id, name, ext, bytes, sha256, version, r2_key, status, created_at, updated_at, crc32)
         SELECT ?2, ?1, ?3, 'pptx', ?4, ?5, 1, ?6, 'ready', ?7, ?7, ?8
         WHERE EXISTS (SELECT 1 FROM app_user WHERE id = ?1 AND status = 'active'
                 AND used_bytes + reserved_bytes + ?4 <= COALESCE(quota_bytes, ?9))
           AND (SELECT count(*) FROM library_file WHERE user_id = ?1 AND status != 'purged') < ?10`,
      )
      .bind(userId, id, SAMPLE_NAME, deck.length, sha256, key, now, crc32(deck), limits.quotaBytes, limits.maxFiles),
    db
      .prepare(
        "UPDATE app_user SET used_bytes = used_bytes + ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM library_file WHERE id = ?3 AND user_id = ?1)",
      )
      .bind(userId, deck.length, id),
    db
      .prepare(
        `INSERT INTO derived (file_id, version, owner_kind, status, created_at, updated_at)
         SELECT ?1, 1, 'library', 'queued', ?2, ?2 WHERE EXISTS (SELECT 1 FROM library_file WHERE id = ?1 AND user_id = ?3)`,
      )
      .bind(id, now, userId),
  ]);
  if (inserted && inserted.meta.changes > 0) return { ok: true, id };
  await bucket.delete(key);
  const count = await db
    .prepare("SELECT count(*) AS n FROM library_file WHERE user_id = ?1 AND status != 'purged'")
    .bind(userId)
    .first<{ n: number }>();
  return { ok: false, error: (count?.n ?? 0) >= limits.maxFiles ? "library_full" : "quota_exceeded" };
}
