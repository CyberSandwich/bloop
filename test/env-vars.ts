import { RATE_LIMIT_BINDINGS } from "../src/worker/config.ts";

/** Every platform rate-limit binding, each allowing everything: a production config refuses a missing one (PAIR-13). */
export const RATE_LIMIT_STUBS = Object.fromEntries(
  RATE_LIMIT_BINDINGS.map((name) => [name, { limit: async () => ({ success: true }) }]),
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
