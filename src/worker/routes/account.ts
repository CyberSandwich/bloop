// The account routes, /api/me*, for email members and Entra users alike (ADRs 0013, 0014). The Entra sign-in and the
// grant's disconnect stay in auth.ts, behind the Graph configuration.
import { type ZodType, z } from "zod";
import { accountEvent } from "../audit.ts";
import { readCookie, SESSION_COOKIE, signedOutCookies, withCookies } from "../auth/cookies.ts";
import { dbOf } from "../auth/db.ts";
import { isLocalRequest } from "../auth/local.ts";
import {
  type Member,
  type MemberOptions,
  memberOf,
  requireAdmin,
  requireFresh,
  resolveMember,
} from "../auth/member.ts";
import { displayName } from "../auth/names.ts";
import { deletePasskey, listPasskeys, renamePasskey } from "../auth/passkeys.ts";
import { endSessions, type ScreenDeps, screenDeps } from "../auth/screens.ts";
import { servicesFor } from "../auth/services.ts";
import { PUBLIC_ID } from "../auth/sessions.ts";
import { type Config, isLocalOrigin } from "../config.ts";
import type { Env, RateLimitName } from "../env.ts";
import { auditRecord } from "../export-format.ts";
import { checkWrite, fail, json, readJson } from "../http.ts";
import { base64url } from "../ids.ts";
import { launchState } from "../mode.ts";
import { type Route, route } from "../router.ts";
import { auditFor } from "../stores.ts";
import { recordBestEffort } from "./auth.ts";
import { emptyBody, limited, withConfig, write } from "./common.ts";

const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1366}$/;
const renameBody = z.object({ name: displayName }).strict();

/** Cursor paging for /api/me/audit: `beforeId` is the `id` of the last row of the previous page. */
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
});

/**
 * With FILE_SOURCE=mock, no session cookie and a local origin and request, the demo account is the user, as before
 * accounts. A deployed origin never answers it: there only a real session is signed in.
 */
const MOCK_ME = { source: "mock", signedIn: true, email: null } as const;

export interface AccountDeps extends ScreenDeps {
  /** The block list seam. TRANSITIONAL(a-4): until a-4 fills it with moderation's `isBlocked`, no address is blocked. */
  isBlocked(env: Env, emailNorm: string): Promise<boolean>;
}

const defaultDeps: AccountDeps = { ...screenDeps, isBlocked: async () => false };

/** The WebAuthn user handle: the bytes of app_user.id, base64url (ADR 0014), for the signal API. */
const userHandle = (userId: string): string => base64url(new TextEncoder().encode(userId));

/** The session cookie and the live session it names, if any: the one lookup every account route starts from. */
async function sessionView(request: Request, env: Env, config: Config) {
  const cookie = readCookie(request, SESSION_COOKIE);
  const { sessions, vault } = servicesFor(env, config);
  const view = cookie ? await sessions.lookup(cookie) : null;
  return { cookie, sessions, vault, view };
}

export interface MemberCall<T> {
  env: Env;
  config: Config;
  member: Member;
  body: T;
  match: URLPatternResult;
}

export interface MemberRouteOptions<T> extends MemberOptions {
  /** A write: the Origin, Sec-Fetch-Site and JSON checks, then this schema. Absent for a read. */
  body?: ZodType<T>;
  /**
   * A (ADR 0014): anyone but an admin, signed out included, gets `not_found` before the write checks and the body, so
   * a foreign Origin or a wrong content type looks exactly like a missing path.
   */
  admin?: boolean;
  /** The platform limit the route spends after the member is known, keyed by the member (RL_MEMBER when absent). */
  limit?: RateLimitName;
}

/**
 * A route for a signed-in member. Every route spends the coarse IP-keyed RL_MEMBER_IP before the session read, so no
 * D1 read goes unmetered; then the member-keyed limit, which is the one that binds a shared campus address. A write
 * also checks Origin, Sec-Fetch-Site and the content type first and reads the body last, so a refused caller learns
 * nothing from the schema. An admin route checks nothing else before the admin check and answers a refusal of the IP
 * meter with `not_found`, so a non-admin's answer is the unknown path's at every request count.
 */
export function memberRoute<T = Record<string, never>>(
  methods: readonly string[],
  path: string,
  options: MemberRouteOptions<T>,
  work: (call: MemberCall<T>) => Promise<Response>,
): Route {
  return route(methods, path, "api", (request, env, match, ctx) =>
    withConfig(async (req, e, config) => {
      const writes = options.body !== undefined;
      const refusedWrite = () => (writes ? checkWrite(req, config.origin) : null);
      const early = options.admin ? null : refusedWrite();
      if (early) return early;
      const flood = await limited(e, "RL_MEMBER_IP", req, config);
      if (flood) return options.admin ? fail("not_found") : flood;
      const who = await resolveMember(req, e, config, options);
      const hidden = options.admin ? (who.ok ? requireAdmin(who.member) : fail("not_found")) : null;
      if (hidden) return hidden;
      if (!who.ok) return who.response;
      const late = options.admin ? refusedWrite() : null;
      if (late) return late;
      const tooMany = await limited(e, options.limit ?? "RL_MEMBER", req, config, who.member.userId);
      if (tooMany) return tooMany;
      let body = {} as T;
      if (options.body) {
        const parsed = await readJson(req, options.body);
        if (!parsed.ok) return parsed.response;
        body = parsed.value;
      }
      return work({ env: e, config, member: who.member, body, match });
    })(request, env, match, ctx),
  );
}

const noContent = (): Response => new Response(null, { status: 204 });

/** The path's `:id` when it has the expected form. */
const param = (match: URLPatternResult, pattern: RegExp): string | null => {
  const id = match.pathname.groups.id ?? "";
  return pattern.test(id) ? id : null;
};

/** The routes, with the live-layer calls and the block list injected so a test can watch them. */
export function accountRoutesWith(deps: AccountDeps): readonly Route[] {
  /**
   * Sign out (this session) or sign out everywhere. Any live session may end itself, so an Entra user, a deleting
   * member and one the lockout refuses can all sign out. A dead or missing session still gets the cookies cleared,
   * so the hint never outlives the session it stood beside.
   */
  const signOut = (everywhere: boolean) =>
    withConfig(async (request, env, config) => {
      const body = await write(request, config, emptyBody);
      if (!body.ok) return body.response;
      const flood = await limited(env, "RL_MEMBER_IP", request, config);
      if (flood) return flood;
      const cleared = signedOutCookies({ everywhere });
      const { cookie, sessions, view } = await sessionView(request, env, config);
      if (!cookie || !view) return withCookies(fail("auth_required"), cleared);
      const tooMany = await limited(env, "RL_MEMBER", request, config, view.userId);
      if (tooMany) return tooMany;
      if (everywhere) {
        await endSessions(deps, env, view.userId, await sessions.destroyAll(view.userId));
      } else {
        await sessions.destroy(cookie);
        if (view.publicId) {
          await endSessions(deps, env, view.userId, [view.publicId], { bySession: view.publicId });
        }
      }
      return withCookies(json({ signedIn: false }), cleared);
    });

  return [
    route(
      ["GET"],
      "/api/me",
      "api",
      withConfig(async (request, env, config) => {
        // The coarse per-IP meter first, so no settings or session read goes unmetered; the member's own after it.
        const flood = await limited(env, "RL_MEMBER_IP", request, config);
        if (flood) return flood;
        const cookie = readCookie(request, SESSION_COOKIE);
        if (!cookie && !config.graph && isLocalOrigin(config.origin) && isLocalRequest(request)) {
          return json({ ...MOCK_ME, launchMode: (await launchState(env)).mode });
        }
        const { sessions, view } = await sessionView(request, env, config);
        const tooMany = view ? await limited(env, "RL_MEMBER", request, config, view.userId) : null;
        if (tooMany) return tooMany;
        if (view && view.tid !== "email" && config.graph) {
          return json({ source: "graph", signedIn: true, email: view.email });
        }
        const { mode: launchMode } = await launchState(env);
        // C(d): a deleting member sees their deletion and can restore; every other refusal reads as signed out.
        const who = view ? await memberOf(view, env, config, sessions, { allowDeleting: true }) : null;
        // A read never clears a cookie: a slow GET that resolved before a sign-in rotated the session would otherwise
        // clear the new one. Only a write or an explicit sign-out clears.
        if (!who?.ok) return json({ source: config.fileSource, signedIn: false, launchMode });
        const { member } = who;
        const summary = await sessions.summary(member.userId);
        return json({
          source: config.fileSource,
          signedIn: true,
          email: member.email,
          admin: member.admin,
          launchMode,
          status: member.status,
          deleteAfter: member.status === "deleting" ? member.deleteAfter : null,
          passkeys: summary.passkeys,
          quota: { used: summary.usedBytes, total: summary.quotaBytes ?? config.library.quotaBytes },
          userHandle: userHandle(member.userId),
        });
      }),
    ),

    route(["POST"], "/api/me/signout", "api", signOut(false)),
    // AUTH-13: every session of the user, every live screen, and the known-device cookie.
    route(["POST"], "/api/me/signout-all", "api", signOut(true)),

    memberRoute(["GET"], "/api/me/sessions", {}, async ({ env, config, member }) =>
      json(await servicesFor(env, config).sessions.list(member.userId, member.session.hash)),
    ),

    memberRoute(["DELETE"], "/api/me/sessions/:id", { body: emptyBody }, async ({ env, config, member, match }) => {
      const id = param(match, PUBLIC_ID);
      // This device signs out through /api/me/signout, which also clears its cookies.
      if (!id || id === member.session.publicId) return fail("bad_request");
      if (!(await servicesFor(env, config).sessions.destroyPublic(member.userId, id))) return fail("not_found");
      await endSessions(deps, env, member.userId, [id], { bySession: id });
      return noContent();
    }),

    memberRoute(["GET"], "/api/me/passkeys", {}, async ({ env, member }) =>
      json(await listPasskeys(dbOf(env.DB), member.userId)),
    ),

    memberRoute(["PATCH"], "/api/me/passkeys/:id", { body: renameBody }, async ({ env, member, body, match }) => {
      const id = param(match, CREDENTIAL_ID);
      if (!id) return fail("bad_request");
      return (await renamePasskey(dbOf(env.DB), member.userId, id, body.name))
        ? json({ id, name: body.name })
        : fail("not_found");
    }),

    // C+R (ADR 0014): a stolen session alone cannot remove the member's passkeys.
    memberRoute(["DELETE"], "/api/me/passkeys/:id", { body: emptyBody }, async ({ env, config, member, match }) => {
      const id = param(match, CREDENTIAL_ID);
      if (!id) return fail("bad_request");
      const stale = requireFresh(member, config);
      if (stale) return stale;
      return (await deletePasskey(dbOf(env.DB), member.userId, id)) ? noContent() : fail("not_found");
    }),

    // The guarded restore (ADR 0013). A closed account's address is blocked, so it cannot undo its own close.
    memberRoute(
      ["POST"],
      "/api/me/restore",
      { body: emptyBody, allowDeleting: true },
      async ({ env, config, member }) => {
        if (await deps.isBlocked(env, member.emailNorm)) return fail("restore_too_late");
        const restored = member.status === "active" || (await servicesFor(env, config).sessions.restore(member.userId));
        return restored ? json({ signedIn: true, deleting: false }) : fail("restore_too_late");
      },
    ),

    // Subject access: the user's own audit rows, most recently recorded first, a page at a time (DATA-05). A member
    // passes C; an Entra user needs the Graph configuration, as before accounts.
    route(
      ["GET"],
      "/api/me/audit",
      "api",
      withConfig(async (request, env, config) => {
        const query = pageQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!query.success) return fail("bad_request");
        const flood = await limited(env, "RL_MEMBER_IP", request, config);
        if (flood) return flood;
        const { sessions, view } = await sessionView(request, env, config);
        if (!view) return fail("auth_required");
        if (view.tid === "email") {
          const who = await memberOf(view, env, config, sessions);
          if (!who.ok) return who.response;
        } else if (!config.graph) return fail("source_unavailable");
        const tooMany = await limited(env, "RL_MEMBER", request, config, view.userId);
        if (tooMany) return tooMany;
        const { limit, beforeId } = query.data;
        const rows = await auditFor(env).forUser(view.userId, limit, beforeId);
        return json({ rows: rows.map(auditRecord), nextId: rows.length === limit ? (rows.at(-1)?.id ?? null) : null });
      }),
    ),

    // Erasure (DATA-05). An Entra user is erased now: the user row, grant and sessions go, and audit rows keep the
    // session and lose the person. An email member starts the deletion grace instead, and the purge removes them with
    // their R2 objects (ADR 0013).
    route(
      ["DELETE"],
      "/api/me",
      "api",
      withConfig(async (request, env, config) => {
        const body = await write(request, config, emptyBody);
        if (!body.ok) return body.response;
        const flood = await limited(env, "RL_MEMBER_IP", request, config);
        if (flood) return flood;
        const { sessions, vault, view } = await sessionView(request, env, config);
        if (!view) return fail("auth_required");
        const { userId } = view;
        if (view.tid === "email") {
          // C, with the lockout read fresh (ADR 0026): a suspended or locked-out member is signed out here too.
          const who = await memberOf(view, env, config, sessions, { fresh: true });
          if (!who.ok) return who.response;
          // C+R (ADR 0014): a stolen or shared session alone cannot start the deletion.
          const stale = requireFresh(who.member, config);
          if (stale) return stale;
          const deleteAfter = Date.now() + config.account.deleteGraceDays * 86_400_000;
          const ended = await sessions.requestDeletion(userId, deleteAfter, view.hash);
          await endSessions(deps, env, userId, ended);
          return json({ signedIn: true, deleting: true });
        }
        if (!config.graph) return fail("source_unavailable");
        const audit = auditFor(env);
        // Recorded first and not best effort: an erasure nobody can later see is worse than a failed one.
        await audit.record(accountEvent("user.erased", userId, Date.now()));
        if (await vault.has(userId)) await recordBestEffort(env, accountEvent("grant.deleted", userId, Date.now()));
        // Before the user row goes: its sessions are found through the user id, which the delete clears.
        await audit.anonymizeUser(userId);
        await sessions.deleteUser(userId);
        return withCookies(json({ signedIn: false }), signedOutCookies({ everywhere: true }));
      }),
    ),
  ];
}

export const accountRoutes: readonly Route[] = accountRoutesWith(defaultDeps);
