// Bindings and vars as wrangler.jsonc declares them. Parsing and validation of vars is config.ts's job.
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
  PUBLIC_ORIGIN: string;
}
