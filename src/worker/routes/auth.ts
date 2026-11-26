// Sign-in. The email code and the invite (ADR 0014): signed-out writes, each answering one shape whoever asks. The
// Entra sign-in and the grant's disconnect (architecture section 6) exist only when FILE_SOURCE=graph with the Entra
// settings present; otherwise each answers `source_unavailable` (docs/setup.md).
import { type ZodType, z } from "zod";
import { type AuditEvent, accountEvent } from "../audit.ts";
import { isKnown, issueCode, newDeviceValue, verifyCode } from "../auth/codes.ts";
import {
  clearCookie,
  DEVICE_COOKIE,
  OAUTH_COOKIE,
  openCookie,
  readCookie,
  SESSION_COOKIE,
  sealCookie,
  setCookie,
  signedInCookies,
  signedOutCookies,
  withCookies,
} from "../auth/cookies.ts";
import { type Db, dbOf } from "../auth/db.ts";
import { emailSwitchOf, type Message, mail, type Sender } from "../auth/email.ts";
import { normalizeEmail } from "../auth/email-norm.ts";
import { callbackErrorPage } from "../auth/error-page.ts";
import { acceptBatch, inviteHash, maskEmail, peekInvite } from "../auth/invites.ts";
import { resolveMember } from "../auth/member.ts";
import { beginSignIn, finishSignIn, PENDING_SECONDS, type Pending } from "../auth/oauth.ts";
import { MAX_PASSKEYS } from "../auth/passkeys.ts";
import { endSessions, type ScreenDeps, screenDeps } from "../auth/screens.ts";
import { phoneUser, servicesFor } from "../auth/services.ts";
import { deviceLabel, SESSION_MAX_AGE_SECONDS } from "../auth/sessions.ts";
import { signinCode } from "../auth/templates.ts";
import {
  type TurnstileCheck,
  type TurnstileConfig,
  type TurnstileVerdict,
  verifyTurnstile,
} from "../auth/turnstile.ts";
import type { Config, GraphConfig } from "../config.ts";
import type { Env, RateLimitName } from "../env.ts";
import { fail, json } from "../http.ts";
import { newRef, SECRET_SHAPE } from "../ids.ts";
import { admitted, type LaunchState, launchOf, launchState } from "../mode.ts";
import { type BlockCheck, blockCheck } from "../moderation/actions.ts";
import { signinNext } from "../page-registry.ts";
import { type Route, route } from "../router.ts";
import { readSettings, type Settings } from "../settings.ts";
import { capOverridesOf } from "../spend/caps.ts";
import type { CallerMeter, Spend } from "../spend/client.ts";
import { auditFor } from "../stores.ts";
import { emptyBody, ipHash, limited, withConfig, write } from "./common.ts";

/** A challenge id: a `newRef` (codes.ts `issueCode`). */
const CHALLENGE_ID = /^[A-Za-z0-9_-]{22}$/;

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

/** What the email sign-in routes call beyond D1, injected so a test can stand in for each. */
export interface AuthDeps extends ScreenDeps {
  isBlocked: BlockCheck;
  /** The spend client mail takes from (route deps, ADR 0029). */
  spend(env: Env, settings: Settings): Pick<Spend, "take">;
  turnstile(config: TurnstileConfig, token: string, check: TurnstileCheck): Promise<TurnstileVerdict>;
}

/**
 * The guard's client (`spendFor`, guard.ts), imported at the first take: guard.ts loads workerd's runtime module, which
 * a route module imported outside workerd (the unit runner) cannot.
 */
const guardSpend: AuthDeps["spend"] = (env, settings) => ({
  take: (async (meter: CallerMeter, n: number, scope?: string) => {
    const { spendFor } = await import("../spend/guard.ts");
    return spendFor(env, () => capOverridesOf(settings)).take(meter as "email", n, scope);
  }) as Spend["take"],
});

const defaultDeps: AuthDeps = {
  ...screenDeps,
  isBlocked: blockCheck,
  spend: guardSpend,
  turnstile: (config, token, check) => verifyTurnstile(config, token, check),
};

const token = z.object({ token: z.string().regex(SECRET_SHAPE) }).strict();
const codeAnswer = z
  .object({ challengeId: z.string().regex(CHALLENGE_ID), code: z.string().regex(/^\d{6}$/) })
  .strict();
const codeRequest = z.object({ email: z.string().max(254), turnstile: z.string().min(1).max(2048) }).strict();

const nextPath = (request: Request, admin: boolean): string =>
  signinNext(new URL(request.url).searchParams.get("next"), admin);

/** A code's lifetime as the 202 states it: the absolute expiry, and the time left, so no device clock reads it. */
const lifetime = (expiresAt: number) => ({ expiresAt, expiresIn: Math.max(0, expiresAt - Date.now()) });

/** A line only on refusal or error, by code: never an address, code, token or user agent. */
const logAuth = (kind: string, code: string) => console.log(JSON.stringify({ evt: "auth", kind, code }));

interface EmailUser {
  id: string;
  email: string | null;
  status: string;
  suspendedAt: number | null;
  deviceEpoch: number;
}

async function emailUser(db: Db, emailNorm: string): Promise<EmailUser | null> {
  const row = await db
    .prepare(
      "SELECT id, email, status, suspended_at, device_epoch FROM app_user WHERE email_norm = ? AND tid = 'email'",
    )
    .bind(emailNorm)
    .first<{ id: string; email: string | null; status: string; suspended_at: number | null; device_epoch: number }>();
  return row
    ? {
        id: row.id,
        email: row.email,
        status: row.status,
        suspendedAt: row.suspended_at,
        deviceEpoch: row.device_epoch,
      }
    : null;
}

/** Who receives and redeems a sign-in code (ADR 0014): active or in the deletion grace, never suspended or purging. */
const signsIn = (user: EmailUser): boolean =>
  (user.status === "active" || user.status === "deleting") && user.suspendedAt === null;

/** In preview an invite works only for ADMIN_EMAILS and TEST_EMAILS, as if the lockout were on (MODE-01). */
const inviteAdmitted = (state: LaunchState, account: Config["account"], emailNorm: string): boolean =>
  state.mode === "open" || admitted({ mode: "preview", lockout: true }, account, emailNorm);

interface PublicCall<T> {
  request: Request;
  env: Env;
  config: Config;
  ctx: ExecutionContext;
  body: T;
  pepper: string;
}

/** A signed-out write: config, then the write checks and body, then the IP limit, then CODE_PEPPER, then the work. */
function publicWrite<T>(
  path: string,
  schema: ZodType<T>,
  limit: RateLimitName,
  work: (call: PublicCall<T>) => Promise<Response>,
): Route {
  return route(["POST"], path, "api", (request, env, match, ctx) =>
    withConfig(async (req, e, config) => {
      const body = await write(req, config, schema);
      if (!body.ok) return body.response;
      const tooMany = await limited(e, limit, req, config);
      if (tooMany) return tooMany;
      const pepper = config.secrets.codePepper;
      if (!pepper) {
        logAuth("config", "no_pepper");
        return fail("internal");
      }
      return work({ request: req, env: e, config, ctx, body: body.value, pepper });
    })(request, env, match, ctx),
  );
}

/** The email and invite sign-in routes (ADR 0014) and the Entra ones, with their outside calls injected. */
export function authRoutesWith(over: Partial<AuthDeps> = {}): readonly Route[] {
  const deps: AuthDeps = { ...defaultDeps, ...over };
  const templateConfig = (config: Config) => ({ origin: config.origin, codeTtlSeconds: config.account.codeTtlSeconds });

  /**
   * After the response (AUTH-10): `pick` decides whether anything goes out, so no check a send needs (the block list,
   * the mode, the spend takes) runs on the response path. Never throws into the runtime.
   */
  const afterResponse = (
    { env, config, ctx }: Pick<PublicCall<unknown>, "env" | "config" | "ctx">,
    pick: (settings: Settings) => Promise<Message | null>,
  ) =>
    ctx.waitUntil(
      (async () => {
        const settings = await readSettings(env);
        const message = await pick(settings);
        if (!message) return;
        const sending: Promise<unknown>[] = [];
        const mailDeps = {
          account: config.account,
          sender: env.EMAIL as unknown as Sender,
          spend: deps.spend(env, settings),
          emailSwitch: emailSwitchOf(env, settings),
        };
        await mail(mailDeps, { waitUntil: (p) => void sending.push(p) }, message);
        await Promise.all(sending);
      })().catch(() => logAuth("mail", "error")),
    );

  /** A verified member's session: rotation (AUTH-08), the device value unless this device already holds a live one. */
  async function signIn(call: PublicCall<unknown>, user: EmailUser, emailNorm: string): Promise<Response> {
    const { request, env, config, pepper } = call;
    const { sessions } = servicesFor(env, config);
    const known = await isKnown(readCookie(request, DEVICE_COOKIE), pepper, user.id, user.deviceEpoch);
    const session = await sessions.create(user.id, readCookie(request, SESSION_COOKIE), {
      method: "code",
      label: deviceLabel(request.headers.get("User-Agent")),
      reauthAt: Date.now(),
    });
    const { passkeys } = await sessions.summary(user.id);
    return withCookies(
      json({
        next: nextPath(request, config.account.adminEmails.has(emailNorm)),
        offerPasskey: passkeys < MAX_PASSKEYS,
      }),
      signedInCookies(session, known ? null : await newDeviceValue(pepper, user.id, user.deviceEpoch)),
    );
  }

  return [
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
        const flood =
          (await limited(env, "RL_AUTH", request, config)) ?? (await limited(env, "RL_MEMBER_IP", request, config));
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

    // AUTH-10: the same 202 for every well-formed address, a row written either way, and the mail decided after the
    // response; only an eligible member admitted by the mode and off the block list gets one.
    publicWrite("/api/auth/code/request", codeRequest, "RL_CODE", async (call) => {
      const { request, env, config, body, pepper } = call;
      const emailNorm = normalizeEmail(body.email);
      if (!emailNorm) return fail("email_invalid");
      const human = await deps.turnstile(config, body.turnstile, { request, action: "signin" });
      if (!human.ok) {
        logAuth("turnstile", human.reason);
        return fail("turnstile_failed");
      }
      const db = dbOf(env.DB);
      const user = await emailUser(db, emailNorm);
      const known = await isKnown(readCookie(request, DEVICE_COOKIE), pepper, user?.id ?? null, user?.deviceEpoch ?? 0);
      const issued = await issueCode(
        db,
        pepper,
        { purpose: "signin", emailNorm, known },
        config.account.codeTtlSeconds,
      );
      if (issued.limited) return fail("rate_limited", undefined, issued.retryAfterSeconds);
      afterResponse(call, async (settings) => {
        if (!user || !signsIn(user) || !admitted(launchOf(settings), config.account, emailNorm)) return null;
        if (await deps.isBlocked(env, pepper, emailNorm)) return null;
        const codeScope = await ipHash(request, config);
        return { to: user.email ?? emailNorm, ...signinCode({ code: issued.code }, templateConfig(config)), codeScope };
      });
      return json({ challengeId: issued.challengeId, ...lifetime(issued.expiresAt) }, 202);
    }),

    // Every failure is `code_invalid`, including a member suspended, blocked or locked out since the code went.
    publicWrite("/api/auth/code/verify", codeAnswer, "RL_AUTH", async (call) => {
      const { env, config, body, pepper } = call;
      const db = dbOf(env.DB);
      const code = await verifyCode(db, pepper, { id: body.challengeId, purpose: "signin", code: body.code });
      const user = code ? await emailUser(db, code.emailNorm) : null;
      if (!code || !user || !signsIn(user)) return fail("code_invalid");
      const state = await launchState(env, { fresh: true });
      if (!admitted(state, config.account, code.emailNorm) || (await deps.isBlocked(env, pepper, code.emailNorm)))
        return fail("code_invalid");
      return signIn(call, user, code.emailNorm);
    }),

    // INV-03: reads only. Revoked, unknown and (in preview) a non-test invite all read `invalid` (MODE-01). A live
    // session learns only whether the invite is its own (`forYou`), never the address.
    publicWrite("/api/invite/peek", token, "RL_INVITE", async ({ request, env, config, body }) => {
      const { state, row } = await peekInvite(dbOf(env.DB), await inviteHash(body.token), Date.now());
      if (!row || !inviteAdmitted(await launchState(env), config.account, row.emailNorm))
        return json({ state: "invalid" });
      if (state !== "open") return json({ state });
      const who = readCookie(request, SESSION_COOKIE) ? await resolveMember(request, env, config) : null;
      return json({
        state,
        emailMasked: maskEmail(row.email),
        expiresAt: row.expiresAt,
        ...(who?.ok ? { forYou: who.member.emailNorm === row.emailNorm } : {}),
      });
    }),

    // INV-02: the code goes to the invite's own address; the body carries nothing else to send it to.
    publicWrite("/api/invite/accept", token, "RL_INVITE", async (call) => {
      const { env, config, body, pepper } = call;
      const db = dbOf(env.DB);
      const { state, row } = await peekInvite(db, await inviteHash(body.token), Date.now());
      const open = state === "open" && row !== null;
      if (!open || !inviteAdmitted(await launchState(env, { fresh: true }), config.account, row.emailNorm))
        return fail("invite_dead");
      if (await deps.isBlocked(env, pepper, row.emailNorm)) return fail("invite_dead");
      const issued = await issueCode(
        db,
        pepper,
        { purpose: "invite", emailNorm: row.emailNorm, inviteId: row.id },
        config.account.codeTtlSeconds,
      );
      if (issued.limited) return fail("rate_limited", undefined, issued.retryAfterSeconds);
      afterResponse(call, async () => ({
        to: row.email,
        ...signinCode({ code: issued.code }, templateConfig(config)),
      }));
      return json(
        { challengeId: issued.challengeId, emailMasked: maskEmail(row.email), ...lifetime(issued.expiresAt) },
        202,
      );
    }),

    // The code spends the invite: the user, the acceptance (with the Terms version) and the session in one batch.
    publicWrite("/api/invite/verify", codeAnswer, "RL_AUTH", async (call) => {
      const { request, env, config, body, pepper } = call;
      const db = dbOf(env.DB);
      const code = await verifyCode(db, pepper, { id: body.challengeId, purpose: "invite", code: body.code });
      if (!code?.inviteId) return fail("code_invalid");
      if (!inviteAdmitted(await launchState(env, { fresh: true }), config.account, code.emailNorm))
        return fail("invite_dead");
      const userId = newRef();
      const now = Date.now();
      const session = await servicesFor(env, config).sessions.issue(userId, readCookie(request, SESSION_COOKIE), {
        method: "code",
        label: deviceLabel(request.headers.get("User-Agent")),
        reauthAt: now,
      });
      if (!(await acceptBatch(db, { inviteId: code.inviteId, userId, session: session.statements, now })))
        return fail("invite_dead");
      return withCookies(
        json({ next: "/library", offerPasskey: true }),
        signedInCookies(session.value, await newDeviceValue(pepper, userId, 0)),
      );
    }),
  ];
}

export const authRoutes: readonly Route[] = authRoutesWith();
