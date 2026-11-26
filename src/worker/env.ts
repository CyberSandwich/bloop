// Bindings and vars as wrangler.jsonc declares them. Parsing and validation of vars is config.ts's job.
// The Durable Object namespaces stay untyped here so Node-side tests can import types from modules
// that depend on Env; stubs.ts types them.
export interface Env {
  ASSETS: Fetcher;
  SCREEN: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  USER_LIBRARY: DurableObjectNamespace;
  CONVERTER: DurableObjectNamespace;
  SPEND_GUARD: DurableObjectNamespace;
  DB: D1Database;
  GUEST_FILES: R2Bucket;
  LIBRARY: R2Bucket;
  /** Email Service, sender hi@bloop.here, any recipient (auth/email.ts). */
  EMAIL: SendEmail;
  RL_CREATE: RateLimit;
  RL_CLAIM: RateLimit;
  RL_FETCH: RateLimit;
  RL_UPLOAD: RateLimit;
  RL_AUTH: RateLimit;
  RL_EXPORT: RateLimit;
  RL_DEMO_CREATE: RateLimit;
  RL_DEMO_CLAIM: RateLimit;
  RL_FILES: RateLimit;
  RL_CONTROL: RateLimit;
  RL_UPGRADE: RateLimit;
  RL_CODE: RateLimit;
  RL_INVITE: RateLimit;
  RL_PASSKEY: RateLimit;
  RL_UPLOAD_PART: RateLimit;
  RL_LIBRARY: RateLimit;
  RL_ADMIN: RateLimit;
  RL_REPORT: RateLimit;
  PUBLIC_ORIGIN: string;
  FILE_ORIGIN?: string;
  /** Secrets: both absent means the breaker reads counters only, and every alert says so. */
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/** The platform rate-limit bindings of wrangler.jsonc (a test pins the list to it); `limited` refuses a route lacking one. */
export const RATE_LIMIT_BINDINGS = [
  ...["RL_CREATE", "RL_CLAIM", "RL_FETCH", "RL_UPLOAD", "RL_AUTH"],
  ...["RL_EXPORT", "RL_DEMO_CREATE", "RL_DEMO_CLAIM", "RL_FILES", "RL_CONTROL", "RL_UPGRADE"],
  ...["RL_CODE", "RL_INVITE", "RL_PASSKEY", "RL_UPLOAD_PART", "RL_LIBRARY", "RL_ADMIN", "RL_REPORT"],
] as const satisfies readonly (keyof Env)[];

export type RateLimitName = (typeof RATE_LIMIT_BINDINGS)[number];

/** Every RateLimit binding of Env must be listed: an unlisted one makes this type non-empty and the line below fail. */
type UnlistedRateLimit = Exclude<
  { [K in keyof Env]-?: Env[K] extends RateLimit ? K : never }[keyof Env],
  RateLimitName
>;
export const everyRateLimitListed: [UnlistedRateLimit] extends [never] ? true : UnlistedRateLimit = true;
