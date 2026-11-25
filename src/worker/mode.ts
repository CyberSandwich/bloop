// The launch mode (ADR 0026): preview shows today's product and open adds the account-era surfaces. The mode and the
// optional preview lockout are two rows of `setting`, changed only from /admin. The gate fails closed: a missing row, an
// unknown value or a failed read is preview with no lockout.

import type { LaunchMode } from "../shared/protocol.ts";
import { type Db, dbOf } from "./auth/db.ts";
import { type AccountConfig, configFor } from "./config.ts";

export const MODE_KEY = "launch_mode";
export const LOCKOUT_KEY = "preview_lockout";
/** How long an isolate trusts a read. A switch reaches every isolate within this. */
export const CACHE_MS = 30_000;

export interface LaunchState {
  mode: LaunchMode;
  /** Set only while the mode is preview: accounts outside ADMIN_EMAILS plus TEST_EMAILS are refused. */
  lockout: boolean;
}

const PREVIEW: LaunchState = { mode: "preview", lockout: false };

/** One query, no cache. Anything but the exact open value reads as preview, and the lockout counts only in preview. */
export async function readLaunchState(db: Db): Promise<LaunchState> {
  const { results } = await db
    .prepare("SELECT key, value FROM setting WHERE key IN (?, ?)")
    .bind(MODE_KEY, LOCKOUT_KEY)
    .all<{ key: string; value: string }>();
  const row = new Map(results.map((r) => [r.key, r.value]));
  const open = row.get(MODE_KEY) === "open";
  return open ? { mode: "open", lockout: false } : { mode: "preview", lockout: row.get(LOCKOUT_KEY) === "1" };
}

/**
 * A reader with its own cache, so a test owns one. A failed read answers preview and is not cached, so the next
 * request retries; `fresh` skips the cache for the steps that create state (invite create and accept, code verify,
 * passkey session creation, /admin), so no one slips through the cache window after a switch back to preview.
 */
export function launchReader(now: () => number = Date.now) {
  let cached: { state: LaunchState; at: number } | null = null;
  return async (db: Db, options: { fresh?: boolean; ttlMs?: number } = {}): Promise<LaunchState> => {
    const ttl = options.ttlMs ?? CACHE_MS;
    if (!options.fresh && cached && now() - cached.at < ttl) return cached.state;
    try {
      const state = await readLaunchState(db);
      cached = { state, at: now() };
      return state;
    } catch {
      cached = null;
      console.error("launch_mode_read_failed");
      return PREVIEW;
    }
  };
}

const read = launchReader();

/** The mode for this request. TEST_TIMING turns the cache off so a test sees a switch at once. */
export function launchState(env: { DB: unknown }, options: { fresh?: boolean } = {}): Promise<LaunchState> {
  const config = configFor(env);
  const ttlMs = config.ok && !config.config.testTiming ? CACHE_MS : 0;
  return read(dbOf(env.DB), { ...options, ttlMs });
}

/**
 * Whether the lockout lets this identity act. `emailNorm` is null for an Entra user, who is not a member of the
 * invite-only product and is never locked out by it. Without the lockout everyone passes.
 */
export function admitted(
  state: LaunchState,
  account: Pick<AccountConfig, "adminEmails" | "testEmails">,
  emailNorm: string | null,
): boolean {
  if (!state.lockout || emailNorm === null) return true;
  return account.adminEmails.has(emailNorm) || account.testEmails.has(emailNorm);
}
