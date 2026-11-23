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
  PUBLIC_ORIGIN: string;
}
