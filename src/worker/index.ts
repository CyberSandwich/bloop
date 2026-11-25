import { configFor } from "./config.ts";
import { Directory } from "./do/directory.ts";
import { Screen } from "./do/screen.ts";
import type { Env } from "./env.ts";
import { type Policy, policyOf, withHeaders } from "./headers.ts";
import { json, problem } from "./http.ts";
import { offOrigin } from "./origin.ts";
import { closeStaleSessions, runRetention } from "./retention.ts";
import { type Route, route } from "./router.ts";
import { authRoutes } from "./routes/auth.ts";
import { controlRoutes } from "./routes/control.ts";
import { dropRoutes } from "./routes/drop.ts";
import { exportRoutes } from "./routes/export.ts";
import { fileRoutes } from "./routes/files.ts";
import { logFetch, openRoutes } from "./routes/open.ts";
import { pairingRoutes } from "./routes/pairing.ts";
import { sweepGuestFiles } from "./seams/guest-drop/select.ts";

/** The `triggers.crons` entry in wrangler.jsonc that runs the hourly backstop. */
const HOURLY = "0 * * * *";
/** The daily retention entry. */
const DAILY = "30 3 * * *";

/** Paths the routes own; everything else is a static asset. wrangler.jsonc sends every request to the Worker so the host check sees it. */
const DYNAMIC = /^\/(api|f|auth)\//;

/** First match wins. Later modules add their routes here, one line each. */
const routes: readonly Route[] = [
  route(["GET"], "/api/health", "api", () => json({ status: "ok" })),
  ...pairingRoutes,
  ...fileRoutes,
  ...controlRoutes,
  ...dropRoutes,
  ...authRoutes,
  ...openRoutes,
  ...exportRoutes,
];

/** Methods other than the route's own get 405 with Allow, as /f/ requires for PROPFIND and OPTIONS. */
async function dispatch(request: Request, env: Env): Promise<{ response: Response; policy: Policy }> {
  const url = new URL(request.url);
  const out = await matchRoute(request, env, url);
  if (url.pathname.startsWith("/f/")) logFetch(request, out.response);
  return out;
}

async function matchRoute(request: Request, env: Env, url: URL): Promise<{ response: Response; policy: Policy }> {
  let refused: { allow: Set<string>; policy: Policy } | null = null;
  for (const r of routes) {
    const match = r.pattern.exec(url);
    if (!match) continue;
    if (!r.methods.includes(request.method)) {
      // A path can have a route per method: keep looking, and answer 405 only if none takes this one.
      refused ??= { allow: new Set(), policy: r.policy };
      for (const method of r.methods) refused.allow.add(method);
      continue;
    }
    const response = await r.handler(request, env, match);
    return { response, policy: policyOf(response, r.policy) };
  }
  if (refused) {
    return {
      response: problem(405, "method_not_allowed", { Allow: [...refused.allow].join(", ") }),
      policy: refused.policy,
    };
  }
  return { response: problem(404, "not_found"), policy: "api" };
}

export default {
  async fetch(request, env): Promise<Response> {
    const away = offOrigin(request, env.PUBLIC_ORIGIN);
    if (away) return away;
    if (!DYNAMIC.test(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
    const { response, policy } = await dispatch(request, env);
    // A WebSocket upgrade response must reach the runtime untouched.
    return response.status === 101 ? response : withHeaders(response, policy);
  },

  // Hourly: leftover guest objects (DROP-07) and session rows that lost their end. Daily: retention (DATA-02).
  async scheduled(controller, env) {
    const config = configFor(env);
    if (!config.ok) return console.error(`config invalid: ${config.problems.join("; ")}`);
    if (controller.cron === HOURLY) {
      const swept = await sweepGuestFiles(env, config.config);
      const closed = await closeStaleSessions(env, config.config, Date.now());
      if (swept > 0 || closed > 0) console.log(JSON.stringify({ evt: "hourly", swept, closed }));
    } else if (controller.cron === DAILY) {
      console.log(JSON.stringify({ evt: "retention", ...(await runRetention(env, config.config)) }));
    }
  },
} satisfies ExportedHandler<Env>;

export { Directory, Screen };
