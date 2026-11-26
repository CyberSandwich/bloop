import { configFor } from "./config.ts";
import { runCron } from "./cron.ts";
import { JOBS } from "./cron-jobs.ts";
import { Converter } from "./do/converter.ts";
import { Directory } from "./do/directory.ts";
import { Screen } from "./do/screen.ts";
import { UserLibrary } from "./do/user-library.ts";
import type { Env } from "./env.ts";
import { type Policy, policyOf, withHeaders } from "./headers.ts";
import { json, problem } from "./http.ts";
import { offOrigin } from "./origin.ts";
import { servePage } from "./pages.ts";
import { type Route, route } from "./router.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { controlRoutes } from "./routes/control.ts";
import { devMailRoutes } from "./routes/dev-mail.ts";
import { devR2Routes } from "./routes/dev-r2.ts";
import { dropRoutes } from "./routes/drop.ts";
import { exportRoutes } from "./routes/export.ts";
import { fileOriginRoutes } from "./routes/fileorigin.ts";
import { fileRoutes } from "./routes/files.ts";
import { hookRoutes } from "./routes/hooks.ts";
import { libraryRoutes } from "./routes/library.ts";
import { noteRoutes } from "./routes/notes.ts";
import { logFetch, openRoutes } from "./routes/open.ts";
import { pairingRoutes } from "./routes/pairing.ts";
import { reportRoutes } from "./routes/reports.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import { SpendGuard } from "./spend/guard.ts";

/** Paths the routes own; everything else is a static asset. wrangler.jsonc sends every request to the Worker so the host check sees it. */
const DYNAMIC = /^\/(api|f|auth)\/|^\/fo\/ping$/;

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
  ...accountRoutes,
  ...adminRoutes,
  ...hookRoutes,
  ...reportRoutes,
  ...devMailRoutes,
  ...uploadRoutes,
  ...devR2Routes,
  ...libraryRoutes,
  ...fileOriginRoutes,
  ...noteRoutes,
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
    const away = offOrigin(request, env.PUBLIC_ORIGIN, env.FILE_ORIGIN);
    if (away) return away;
    if (!DYNAMIC.test(new URL(request.url).pathname)) return servePage(request, env);
    const { response, policy } = await dispatch(request, env);
    // A WebSocket upgrade response must reach the runtime untouched.
    return response.status === 101 ? response : withHeaders(response, policy);
  },

  // The jobs of each trigger are listed in cron-jobs.ts.
  async scheduled(controller, env) {
    const config = configFor(env);
    if (!config.ok) return console.error(`config invalid: ${config.problems.join("; ")}`);
    await runCron(controller.cron, env, config.config, JOBS);
  },
} satisfies ExportedHandler<Env>;

// Every class a binding or a migration names must be exported from here.
export { Converter, Directory, Screen, SpendGuard, UserLibrary };
