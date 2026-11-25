import { readFileSync } from "node:fs";

/** Each platform rate-limit binding wrangler.jsonc declares, with its limit per period. */
export const declaredRateLimits = (): Record<string, number> =>
  Object.fromEntries(
    [
      ...readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").matchAll(
        /"name": "(RL_[A-Z_]+)"[^}]*"limit": (\d+)/g,
      ),
    ].map((m) => [m[1], Number(m[2])]),
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
