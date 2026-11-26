import { readFileSync } from "node:fs";

/**
 * One production `ratelimits` entry as wrangler.jsonc writes it, on one line: groups are the text before the limit,
 * the name, the limit, the text after it, and the period. env.staging's multi-line copies never match.
 */
export const RATE_LIMIT_ENTRY =
  /("name": "(RL_[A-Z_]+)", "namespace_id": "\d+", "simple": \{ "limit": )(\d+)(, "period": (\d+) \})/g;

export interface RateLimit {
  limit: number;
  period: number;
}

/**
 * Each platform rate-limit binding wrangler.jsonc (or `text`, a copy of it) declares, with its limit and period:
 * only the one-line production entries `RATE_LIMIT_ENTRY` matches.
 */
export const declaredRateLimits = (
  text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
): Record<string, RateLimit> =>
  Object.fromEntries(
    [...text.matchAll(RATE_LIMIT_ENTRY)].map((m) => [m[2] ?? "", { limit: Number(m[3]), period: Number(m[5]) }]),
  );

/** Every declared binding, each allowing everything: a route refuses a missing one (PAIR-13). */
export const RATE_LIMIT_STUBS = Object.fromEntries(
  Object.keys(declaredRateLimits()).map((name) => [name, { limit: async () => ({ success: true }) }]),
);

/** The Worker variables a production config needs, with an obviously fake pepper. Spread and override per test. */
export const PROD_VARS = {
  PUBLIC_ORIGIN: "https://bloop.example",
  HASH_PEPPER: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  CODE_LENGTH: "6",
  CODE_TTL_SECONDS: "60",
  CODE_GRACE_SECONDS: "10",
  CLAIM_TIMEOUT_SECONDS: "300",
  UPLOAD_TIMEOUT_SECONDS: "900",
  SESSION_MAX_MINUTES: "90",
  DEMO_MAX_MINUTES: "10",
  DEMO_ENABLED: "true",
  GUEST_DROP: "open",
  ...RATE_LIMIT_STUBS,
};
