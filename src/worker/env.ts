// Bindings and vars as wrangler.jsonc declares them. Parsing and validation of vars is config.ts's job.
// The Durable Object namespaces stay untyped here so Node-side tests can import types from modules
// that depend on Env; stubs.ts types them.
export interface Env {
  ASSETS: Fetcher;
  SCREEN: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  DB: D1Database;
  GUEST_FILES: R2Bucket;
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
  PUBLIC_ORIGIN: string;
}

/** The platform rate-limit bindings of wrangler.jsonc (a test pins the list to it); `limited` refuses a route lacking one. */
export const RATE_LIMIT_BINDINGS = [
  ...["RL_CREATE", "RL_CLAIM", "RL_FETCH", "RL_UPLOAD", "RL_AUTH"],
  ...["RL_EXPORT", "RL_DEMO_CREATE", "RL_DEMO_CLAIM", "RL_FILES", "RL_CONTROL"],
] as const satisfies readonly (keyof Env)[];

export type RateLimitName = (typeof RATE_LIMIT_BINDINGS)[number];

/** Every RateLimit binding of Env must be listed: an unlisted one makes this type non-empty and the line below fail. */
type UnlistedRateLimit = Exclude<{ [K in keyof Env]: Env[K] extends RateLimit ? K : never }[keyof Env], RateLimitName>;
export const everyRateLimitListed: [UnlistedRateLimit] extends [never] ? true : UnlistedRateLimit = true;
