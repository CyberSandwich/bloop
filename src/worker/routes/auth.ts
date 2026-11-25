// Sign-in and the account routes (architecture section 6). They exist only when FILE_SOURCE=graph with
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
} from "../auth/cookies.ts";
import { callbackErrorPage } from "../auth/error-page.ts";
import { beginSignIn, finishSignIn, PENDING_SECONDS, type Pending } from "../auth/oauth.ts";
import { phoneUser, servicesFor } from "../auth/services.ts";
import { SESSION_MAX_AGE_SECONDS } from "../auth/sessions.ts";
import type { Config, GraphConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { auditRecord } from "../export-format.ts";
import { fail, json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { auditFor } from "../stores.ts";
import { limited, type WithConfig, withConfig, write } from "./common.ts";

const emptyBody = z.object({}).strict();
const pendingShape = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
});

/** Cursor paging for /api/me/audit: `before` is the `at` of the last row of the previous page. */
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
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
  const session = await services.sessions.create(userId, readCookie(request, SESSION_COOKIE));
  return redirect("/a", [setCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS), clearCookie(OAUTH_COOKIE)]);
});

/** Account rows are evidence, not part of the flow: a failed write must not fail the sign-in or the disconnect. */
async function recordBestEffort(env: Env, event: AuditEvent): Promise<void> {
  try {
    await auditFor(env).record(event);
  } catch {
    console.error("record_failed");
  }
}

/** The signed-in user behind the cookie, or the 401 to send. */
async function signedIn(request: Request, env: Env, config: Config) {
  const services = servicesFor(env, config);
  const session = readCookie(request, SESSION_COOKIE);
  const userId = session ? await services.sessions.resolve(session) : null;
  return session && userId
    ? { ok: true as const, services, session, userId }
    : { ok: false as const, response: fail("auth_required") };
}

/** A write that needs a signed-in user: Origin checks first, then the session. */
const accountWrite =
  (action: (userId: string, session: string, env: Env, config: Config) => Promise<void>): WithConfig =>
  async (request, env, config) => {
    const body = await write(request, config, emptyBody);
    if (!body.ok) return body.response;
    const who = await signedIn(request, env, config);
    if (!who.ok) return who.response;
    await action(who.userId, who.session, env, config);
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
        const hadGrant = await vault.has(userId);
        await vault.delete(userId);
        await sessions.destroyAll(userId);
        if (hadGrant) await recordBestEffort(env, accountEvent("grant.deleted", userId, Date.now()));
      }),
    ),
  ),

  // Subject access: the user's own audit rows, newest first, a page at a time (DATA-05).
  route(
    ["GET"],
    "/api/me/audit",
    "api",
    withGraph(async (request, env, config) => {
      const query = pageQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return fail("bad_request");
      const who = await signedIn(request, env, config);
      if (!who.ok) return who.response;
      const { limit, before } = query.data;
      const rows = await auditFor(env).forUser(who.userId, limit, before);
      return json({ rows: rows.map(auditRecord), next: rows.length === limit ? (rows.at(-1)?.at ?? null) : null });
    }),
  ),

  // Erasure (DATA-05): the user row, grant and sessions go; audit rows keep the session and lose the person. An email
  // member is not erased here: it starts the deletion grace and the purge removes them with their R2 objects (ADR 0013).
  route(
    ["DELETE"],
    "/api/me",
    "api",
    withGraph(
      accountWrite(async (userId, _session, env, config) => {
        const { sessions, vault } = servicesFor(env, config);
        if (await sessions.emailNorm(userId)) {
          return sessions.requestDeletion(userId, Date.now() + config.account.deleteGraceDays * 86_400_000);
        }
        const audit = auditFor(env);
        // Recorded first and not best effort: an erasure nobody can later see is worse than a failed one.
        await audit.record(accountEvent("user.erased", userId, Date.now()));
        if (await vault.has(userId)) await recordBestEffort(env, accountEvent("grant.deleted", userId, Date.now()));
        // Before the user row goes: its sessions are found through the user id, which the delete clears.
        await audit.anonymizeUser(userId);
        await sessions.deleteUser(userId);
      }),
    ),
  ),
];
