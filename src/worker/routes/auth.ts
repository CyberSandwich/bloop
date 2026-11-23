// Sign-in and the account routes (architecture section 6). They exist only when FILE_SOURCE=graph with
// the Entra settings present; otherwise every one answers `source_unavailable` (docs/setup.md).
import { z } from "zod";
import {
  clearCookie,
  OAUTH_COOKIE,
  openCookie,
  readCookie,
  SESSION_COOKIE,
  sealCookie,
  setCookie,
} from "../auth/cookies.ts";
import { beginSignIn, finishSignIn, PENDING_SECONDS, type Pending, type SignInError } from "../auth/oauth.ts";
import { phoneUser, servicesFor } from "../auth/services.ts";
import { SESSION_MAX_AGE_SECONDS } from "../auth/sessions.ts";
import type { Config, GraphConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { fail, json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { limited, type WithConfig, withConfig, write } from "./common.ts";

const emptyBody = z.object({}).strict();
const pendingShape = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
});

const redirectUri = (config: Config) => `${config.origin}/auth/callback`;

const redirect = (location: string, cookies: string[]): Response => {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/** Runs `handler` only when the Graph source is configured. */
const withGraph = (
  handler: (request: Request, env: Env, config: Config, graph: GraphConfig) => Response | Promise<Response>,
) =>
  withConfig((request, env, config) =>
    config.graph ? handler(request, env, config, config.graph) : fail("source_unavailable"),
  );

/** Each failed check maps to the error the phone page already knows how to show. */
const FAILURES: Record<SignInError, () => Response> = {
  state: () => fail("bad_request"),
  consent_declined: () => fail("consent_declined"),
  admin_consent_required: () => fail("admin_consent_required"),
  issuer: () => fail("unauthorized"),
  exchange: () => fail("source_unavailable"),
};

const start = withGraph(async (request, env, config, graph) => {
  const tooMany = await limited(env.RL_AUTH, request, config);
  if (tooMany) return tooMany;
  const { url, pending } = await beginSignIn(graph, redirectUri(config), config.tokenMode, Date.now());
  const sealed = await sealCookie(graph.cookieKey, OAUTH_COOKIE, pending);
  return redirect(url, [setCookie(OAUTH_COOKIE, sealed, PENDING_SECONDS)]);
});

const callback = withGraph(async (request, env, config, graph) => {
  const tooMany = await limited(env.RL_AUTH, request, config);
  if (tooMany) return tooMany;
  const sealed = readCookie(request, OAUTH_COOKIE);
  const parsed = sealed ? pendingShape.safeParse(await openCookie(graph.cookieKey, OAUTH_COOKIE, sealed)) : null;
  if (!parsed?.success) return fail("bad_request");
  const pending: Pending = parsed.data;

  const result = await finishSignIn(graph, new URL(request.url), pending, redirectUri(config));
  if (!result.ok) return FAILURES[result.error]();

  const services = servicesFor(env, config);
  const userId = await services.sessions.upsertUser(result.identity);
  await services.vault.store(userId, {
    refreshToken: config.tokenMode === "refresh" ? result.tokens.refreshToken : null,
    accessToken: result.tokens.accessToken,
    accessExpiresAt: result.tokens.expiresAt,
    scope: result.tokens.scope,
  });
  // Rotation: a new session value on every sign-in, and the presented one is deleted.
  const session = await services.sessions.create(userId, readCookie(request, SESSION_COOKIE));
  return redirect("/a", [setCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS), clearCookie(OAUTH_COOKIE)]);
});

/** A write that needs a signed-in user: Origin checks first, then the session. */
const accountWrite =
  (action: (userId: string, session: string, env: Env, config: Config) => Promise<void>): WithConfig =>
  async (request, env, config) => {
    const body = await write(request, config, emptyBody);
    if (!body.ok) return body.response;
    const services = servicesFor(env, config);
    const session = readCookie(request, SESSION_COOKIE);
    const userId = session ? await services.sessions.resolve(session) : null;
    if (!session || !userId) return fail("auth_required");
    await action(userId, session, env, config);
    return json({ signedIn: false }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
  };

export const authRoutes: readonly Route[] = [
  route(["GET"], "/auth/start", "api", start),
  route(["GET"], "/auth/callback", "api", callback),

  route(
    ["GET"],
    "/api/me",
    "api",
    withConfig(async (request, env, config) => {
      if (!config.graph) return json({ source: "mock", signedIn: true, email: null });
      const services = servicesFor(env, config);
      const userId = await phoneUser(request, services);
      if (!userId) return json({ source: "graph", signedIn: false, email: null });
      return json({ source: "graph", signedIn: true, email: await services.sessions.email(userId) });
    }),
  ),

  // Sign out: this phone only. The grant stays, so the next sign-in is silent.
  route(
    ["POST"],
    "/api/me/signout",
    "api",
    withGraph(
      accountWrite(async (_userId, session, env, config) => servicesFor(env, config).sessions.destroy(session)),
    ),
  ),

  // Revoke: the stored grant and every session of the user go at once (AUTH-07). Entra's consent stays.
  route(
    ["POST"],
    "/api/me/disconnect",
    "api",
    withGraph(
      accountWrite(async (userId, _session, env, config) => {
        const { sessions, vault } = servicesFor(env, config);
        await vault.delete(userId);
        await sessions.destroyAll(userId);
      }),
    ),
  ),
];
