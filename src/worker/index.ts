import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { type Policy, withHeaders } from "./headers.ts";
import { json, problem } from "./http.ts";

type Handler = (request: Request, env: Env, match: URLPatternResult) => Response | Promise<Response>;

interface Route {
  methods: readonly string[];
  pattern: URLPattern;
  policy: Policy;
  handler: Handler;
}

const route = (methods: readonly string[], pathname: string, policy: Policy, handler: Handler): Route => ({
  methods,
  pattern: new URLPattern({ pathname }),
  policy,
  handler,
});

/** First match wins. Later modules add their routes here, one line each. */
const routes: readonly Route[] = [
  route(["GET"], "/api/health", "api", () => json({ status: "ok" })),
  route(["GET", "HEAD"], "/f/:token/:name", "api", () => problem(404, "link_unknown")),
];

/** Methods other than the route's own get 405 with Allow, as /f/ requires for PROPFIND and OPTIONS. */
async function dispatch(request: Request, env: Env): Promise<{ response: Response; policy: Policy }> {
  const url = new URL(request.url);
  for (const r of routes) {
    const match = r.pattern.exec(url);
    if (!match) continue;
    if (!r.methods.includes(request.method)) {
      return {
        response: problem(405, "method_not_allowed", { Allow: r.methods.join(", ") }),
        policy: r.policy,
      };
    }
    return { response: await r.handler(request, env, match), policy: r.policy };
  }
  return { response: problem(404, "not_found"), policy: "api" };
}

export default {
  async fetch(request, env): Promise<Response> {
    const { response, policy } = await dispatch(request, env);
    return withHeaders(response, policy);
  },

  // Hourly backstop and daily retention jobs land in retention.ts.
  async scheduled() {},
} satisfies ExportedHandler<Env>;

export class Screen extends DurableObject<Env> {}
export class Directory extends DurableObject<Env> {}
