// The one reader of the `setting` table (ADR 0026): one SELECT, one cache per isolate, a `fresh` option for the steps
// that create state. A consumer turns the snapshot into its own typed view (mode.ts is the first).
import { type Db, dbOf } from "./auth/db.ts";
import { configFor } from "./config.ts";

/** Raw rows by key; a key with no row is absent. Values are strings: each consumer parses and fails closed. */
export type Settings = Readonly<Record<string, string>>;

/** How long an isolate trusts a read. A switch reaches every isolate within this. */
export const CACHE_MS = 30_000;
/** After a failed read the last good snapshot is served this long, then every key falls back to RESTRICTIVE. */
export const STALE_MS = 300_000;

/** Each key's most restrictive value: what a consumer sees when it cannot know the real one. */
export const RESTRICTIVE: Settings = {
  launch_mode: "preview",
  preview_lockout: "1",
};

async function readAll(db: Db): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM setting").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

/**
 * A reader with its own cache, so a test owns one. A failed read is logged and never cached: the next call retries.
 * `fresh` skips the cache for the steps that create state (invite create and accept, code verify, passkey session
 * creation, /admin), so no one slips through the window after a switch back to preview.
 */
export function settingsReader(now: () => number = Date.now) {
  let good: { settings: Settings; at: number } | null = null;
  return async (db: Db, options: { fresh?: boolean; ttlMs?: number } = {}): Promise<Settings> => {
    const ttl = options.ttlMs ?? CACHE_MS;
    if (!options.fresh && good && now() - good.at < ttl) return good.settings;
    try {
      good = { settings: await readAll(db), at: now() };
      return good.settings;
    } catch {
      console.error("settings_read_failed");
      return !options.fresh && good && now() - good.at < STALE_MS ? good.settings : RESTRICTIVE;
    }
  };
}

const read = settingsReader();

/** The settings for this request. TEST_TIMING (and an invalid configuration) turns the cache off. */
export function readSettings(env: { DB: unknown }, options: { fresh?: boolean } = {}): Promise<Settings> {
  const config = configFor(env);
  const ttlMs = config.ok && !config.config.testTiming ? CACHE_MS : 0;
  return read(dbOf(env.DB), { ...options, ttlMs });
}
