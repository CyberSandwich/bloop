// The Entra sign-in and the grant's disconnect (architecture section 6). They exist only when FILE_SOURCE=graph with
// the Entra settings present; otherwise every one answers `source_unavailable` (docs/setup.md).
import { z } from "zod";
import { type AuditEvent, accountEvent } from "../audit.ts";
import {
  clearCookie,
  OAUTH_COOKIE,
  openCookie,
  readCookie,
  SESSION_COOKIE,
  sealCookie,
  setCookie,
  signedOutCookies,
  withCookies,
} from "../auth/cookies.ts";
import { callbackErrorPage } from "../auth/error-page.ts";
import { beginSignIn, finishSignIn, PENDING_SECONDS, type Pending } from "../auth/oauth.ts";
import { endSessions, type ScreenDeps, screenDeps } from "../auth/screens.ts";
import { phoneUser, servicesFor } from "../auth/services.ts";
import { deviceLabel, SESSION_MAX_AGE_SECONDS } from "../auth/sessions.ts";
import type { Config, GraphConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { fail, json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { auditFor } from "../stores.ts";
import { emptyBody, limited, withConfig, write } from "./common.ts";

const pendingShape = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
});

const redirectUri = (config: Config) => `${config.origin}/auth/callback`;

const redirect = (location: string, cookies: string[]): Response =>
  withCookies(new Response(null, { status: 302, headers: { Location: location } }), cookies);

/** Runs `handler` only when the Graph source is configured. */
const withGraph = (
  handler: (request: Request, env: Env, config: Config, graph: GraphConfig) => Response | Promise<Response>,
) =>
  withConfig((request, env, config) =>
    config.graph ? handler(request, env, config, config.graph) : fail("source_unavailable"),
  );

const start = withGraph(async (request, env, config, graph) => {
  const tooMany = await limited(env, "RL_AUTH", request, config);
  if (tooMany) return tooMany;
  const { url, pending } = await beginSignIn(graph, redirectUri(config), config.tokenMode, Date.now());
  const sealed = await sealCookie(graph.cookieKey, OAUTH_COOKIE, pending);
  return redirect(url, [setCookie(OAUTH_COOKIE, sealed, PENDING_SECONDS)]);
});

const callback = withGraph(async (request, env, config, graph) => {
  const tooMany = await limited(env, "RL_AUTH", request, config);
  if (tooMany) return tooMany;
  const sealed = readCookie(request, OAUTH_COOKIE);
  const parsed = sealed ? pendingShape.safeParse(await openCookie(graph.cookieKey, OAUTH_COOKIE, sealed)) : null;
  if (!parsed?.success) return callbackErrorPage("state");
  const pending: Pending = parsed.data;

  const result = await finishSignIn(graph, new URL(request.url), pending, redirectUri(config));
  if (!result.ok) return callbackErrorPage(result.error);

  const services = servicesFor(env, config);
  const userId = await services.sessions.upsertUser(result.identity);
  const hadGrant = await services.vault.has(userId);
  await services.vault.store(userId, {
    refreshToken: config.tokenMode === "refresh" ? result.tokens.refreshToken : null,
    accessToken: result.tokens.accessToken,
    accessExpiresAt: result.tokens.expiresAt,
    scope: result.tokens.scope,
  });
  if (!hadGrant) await recordBestEffort(env, accountEvent("grant.created", userId, Date.now()));
  // Rotation: a new session value on every sign-in, and the presented one is deleted.
  const session = await services.sessions.create(userId, readCookie(request, SESSION_COOKIE), {
    method: "entra",
    label: deviceLabel(request.headers.get("User-Agent")),
    reauthAt: Date.now(),
  });
  return redirect("/a", [setCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS), clearCookie(OAUTH_COOKIE)]);
});

/** Account rows are evidence, not part of the flow: a failed write must not fail the sign-in or the disconnect. */
export async function recordBestEffort(env: Env, event: AuditEvent): Promise<void> {
  try {
    await auditFor(env).record(event);
  } catch {
    console.error("record_failed");
  }
}

/** The routes, with the live-screen calls injected so a test can watch the disconnect's cleanup. */
export const authRoutesWith = (deps: ScreenDeps): readonly Route[] => [
  route(["GET"], "/auth/start", "api", start),
  route(["GET"], "/auth/callback", "api", callback),

  // Revoke: the stored grant and every session of the user go at once (AUTH-07), with the same session-end cleanup
  // as sign out everywhere. Entra's consent stays.
  route(
    ["POST"],
    "/api/me/disconnect",
    "api",
    withGraph(async (request, env, config) => {
      const body = await write(request, config, emptyBody);
      if (!body.ok) return body.response;
      const flood = await limited(env, "RL_AUTH", request, config);
      if (flood) return flood;
      const services = servicesFor(env, config);
      const { sessions, vault } = services;
      const userId = await phoneUser(request, services);
      if (!userId) return fail("auth_required");
      const hadGrant = await vault.has(userId);
      await vault.delete(userId);
      await endSessions(deps, env, userId, await sessions.destroyAll(userId));
      if (hadGrant) await recordBestEffort(env, accountEvent("grant.deleted", userId, Date.now()));
      return withCookies(json({ signedIn: false }), signedOutCookies({ everywhere: true }));
    }),
  ),
];

export const authRoutes: readonly Route[] = authRoutesWith(screenDeps);
