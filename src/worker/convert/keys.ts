// The R2 layout of a version's outputs and the one place a derived key is built (docs/conversion.md). A prefix comes
// from D1, never from a caller; a relative name must match the stored grammar, so no input shapes a key.
import type { Db } from "../auth/db.ts";
import { STORED } from "./outputs.ts";

export type OwnerKind = "library" | "guest";

/** What a job needs of its file, read live from D1. */
export interface Located {
  bucket: "LIBRARY" | "GUEST_FILES";
  /** The stored original. */
  originalKey: string;
  /** Everything derived lives under it: `<prefix>/d/…` for the bundle, `<prefix>/n/notes.json` for the phone. */
  prefix: string;
  ext: string;
  bytes: number;
  sha256: string | null;
  /** The library file's owner, read from the row so a caller's claim of who owns it is never used; null for a guest. */
  userId: string | null;
}

/**
 * A library file that may be converted and shown: not trashed, not disabled, and its owner neither purging nor
 * suspended. One statement fragment, so a publish and a start agree (L's own export replaces it when it lands).
 */
export const LIBRARY_SERVABLE =
  "f.status IN ('checking', 'ready') AND f.trashed_at IS NULL AND f.disabled_at IS NULL AND u.status != 'purging' AND u.suspended_at IS NULL";
export const LIBRARY_FROM = "library_file f JOIN app_user u ON u.id = f.user_id";
export const GUEST_SERVABLE = "g.deleted_at IS NULL";

/** The original's key without its `/orig` leaf; a guest object has no leaf and is its own prefix. */
export const prefixOf = (originalKey: string): string =>
  originalKey.endsWith("/orig") ? originalKey.slice(0, -"/orig".length) : originalKey;

const extOf = (name: string): string => (name.includes(".") ? (name.split(".").pop() ?? "") : "").toLowerCase();

/** The live, servable file this version names, or null (gone, trashed, disabled, purging, deleted). */
export async function locate(db: Db, ownerKind: OwnerKind, fileId: string, version: number): Promise<Located | null> {
  if (ownerKind === "library") {
    const row = await db
      .prepare(
        `SELECT f.r2_key, f.ext, f.bytes, f.sha256, f.user_id FROM ${LIBRARY_FROM} WHERE f.id = ? AND f.version = ? AND ${LIBRARY_SERVABLE}`,
      )
      .bind(fileId, version)
      .first<{ r2_key: string; ext: string; bytes: number; sha256: string | null; user_id: string }>();
    return row
      ? {
          bucket: "LIBRARY",
          originalKey: row.r2_key,
          prefix: prefixOf(row.r2_key),
          ext: row.ext.toLowerCase(),
          bytes: row.bytes,
          sha256: row.sha256,
          userId: row.user_id,
        }
      : null;
  }
  const row = await db
    .prepare(
      `SELECT g.r2_key, g.name, g.bytes, g.sha256 FROM guest_file g WHERE g.session_id = ? AND ${GUEST_SERVABLE}`,
    )
    .bind(fileId)
    .first<{ r2_key: string; name: string; bytes: number; sha256: string }>();
  return row
    ? {
        bucket: "GUEST_FILES",
        originalKey: row.r2_key,
        prefix: prefixOf(row.r2_key),
        ext: extOf(row.name),
        bytes: row.bytes,
        sha256: row.sha256,
        userId: null,
      }
    : null;
}

/** The R2 key of a stored name. Notes are the only phone-only output and live outside the bundle's `d/`. */
export function outputKey(prefix: string, rel: string): string {
  if (!STORED.test(rel)) throw new RangeError(`not a stored name: ${rel}`);
  return rel === "notes.json" ? notesKey(prefix) : `${prefix}/d/${rel}`;
}

export const notesKey = (prefix: string): string => `${prefix}/n/notes.json`;

/** Every key the bundle may serve for a published version: its stored names, minus the phone-only notes. */
export const bundleAllowlist = (outputs: { files: readonly { path: string }[] }): string[] =>
  outputs.files.map((f) => f.path).filter((p) => p !== "notes.json");
