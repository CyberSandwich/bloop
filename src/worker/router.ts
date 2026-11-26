import type { Env } from "./env.ts";
import type { Policy } from "./headers.ts";

/** `ctx` carries `waitUntil`, so work such as mail runs after the response (AUTH-10); most handlers ignore it. */
export type Handler = (
  request: Request,
  env: Env,
  match: URLPatternResult,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

export interface Route {
  methods: readonly string[];
  pattern: URLPattern;
  policy: Policy;
  handler: Handler;
}

export const route = (methods: readonly string[], pathname: string, policy: Policy, handler: Handler): Route => ({
  methods,
  pattern: new URLPattern({ pathname }),
  policy,
  handler,
});
