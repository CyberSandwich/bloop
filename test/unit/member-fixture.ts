// A Worker-shaped world for the member resolver and the account routes over the d1 shim: config vars, a seeded
// member with a live session, and a direct call into a route table.
import { type SessionOptions, Sessions } from "../../src/worker/auth/sessions.ts";
import { type Config, configFor } from "../../src/worker/config.ts";
import { sha256Hex } from "../../src/worker/ids.ts";
import { declaredRateLimits, PROD_VARS } from "../env-vars.ts";
import { type TestDb, testDb } from "./d1-shim.ts";
import { fakeSpend } from "./spend-helpers.ts";

export const ORIGIN = "http://localhost:8787";

const key = Buffer.alloc(32, 5).toString("base64");
/** The vars that turn on FILE_SOURCE=graph, so the Entra routes (disconnect) exist. */
export const GRAPH = {
  FILE_SOURCE: "graph",
  ENTRA_CLIENT_ID: "client-id",
  ENTRA_CLIENT_SECRET: "x".repeat(12),
  TOKEN_KEKS: JSON.stringify({ k1: key }),
  TOKEN_KEK_CURRENT: "k1",
  COOKIE_KEY: key,
};

export function memberWorld(over: Record<string, string> = {}) {
  const db = testDb();
  const env = {
    ...PROD_VARS,
    PUBLIC_ORIGIN: ORIGIN,
    TEST_TIMING: "1",
    ADMIN_EMAILS: " Admin@Example.TEST ",
    TEST_EMAILS: "test@example.test",
    ...over,
    DB: db,
  };
  const parsed = configFor(env);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return { db, env, config: parsed.config as Config };
}

export const setMode = (db: TestDb, mode: "preview" | "open", lockout = false) => {
  db.raw.prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('launch_mode', ?, 0)").run(mode);
  db.raw.prepare("DELETE FROM setting WHERE key = 'preview_lockout'").run();
  if (lockout) db.raw.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('preview_lockout', '1', 0)").run();
};

/** An email member (or, with another `tid`, an Entra user) and a live session cookie for them. */
export async function seedMember(
  db: TestDb,
  id: string,
  email: string,
  session: Partial<SessionOptions> = {},
  { now = Date.now, tid = "email" }: { now?: () => number; tid?: string } = {},
): Promise<string> {
  db.raw
    .prepare(
      "INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, tid, id, email, tid === "email" ? email : null, now(), now());
  return addSession(db, id, session, now);
}

/** One more live session (another device) for an existing user. */
export const addSession = (
  db: TestDb,
  userId: string,
  session: Partial<SessionOptions> = {},
  now: () => number = Date.now,
): Promise<string> =>
  new Sessions(db, now).create(userId, null, { method: "code", label: null, reauthAt: now(), ...session });

export interface AnyRoute {
  methods: readonly string[];
  pattern: URLPattern;
  handler: (r: Request, env: object, m: URLPatternResult, ctx: object) => Promise<Response>;
}

/** A route module by name. A non-literal specifier: its type graph needs the Workers types the test tsconfig omits. */
export async function routesOf(module: "account" | "admin", name: string): Promise<readonly AnyRoute[]> {
  const path = `../../src/worker/routes/${module}.ts`;
  return (await import(path))[name] as readonly AnyRoute[];
}

const CTX = { waitUntil() {}, passThroughOnException() {} };

/** A ctx whose `waitUntil` work a test can wait for, as the runtime does after the response. */
export function waitingCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
    flush: () => Promise.all(pending),
  };
}

/** Calls the first route matching method and path, as the Worker would, with a same-origin JSON request. */
export async function callRoute(
  routes: readonly AnyRoute[],
  env: object,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; ctx?: object } = {},
): Promise<Response> {
  const url = `${ORIGIN}${path}`;
  const found = routes.find((r) => r.methods.includes(method) && r.pattern.test(url));
  if (!found) throw new Error(`no route for ${method} ${path}`);
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (options.cookie) headers.Cookie = options.cookie;
  const body = method === "GET" ? undefined : JSON.stringify(options.body ?? {});
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(new TextEncoder().encode(body).length);
  }
  const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
  return found.handler(request, env, found.pattern.exec(url) as URLPatternResult, options.ctx ?? CTX);
}

/** The member's known-device epoch (migration 0006). */
export const deviceEpoch = (db: TestDb, userId: string): number =>
  (db.raw.prepare("SELECT device_epoch AS epoch FROM app_user WHERE id = ?").get(userId) as { epoch: number }).epoch;

export const sid = (value: string) => `__Host-bloop_sid=${value}`;

/** The account routes with spies in place of the live layer and the block list; `over` replaces any of them. */
export async function spied(blocked = false, over: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const path = "../../src/worker/routes/account.ts";
  const { accountRoutesWith } = (await import(path)) as { accountRoutesWith: (deps: object) => readonly AnyRoute[] };
  const routes = accountRoutesWith({
    endScreens: async (_env: unknown, userId: string, scope?: object) => {
      calls.push(["endScreens", userId, scope ?? {}]);
    },
    closeSessions: async (_env: unknown, userId: string, publicIds: readonly string[]) => {
      calls.push(["closeSessions", userId, [...publicIds].sort()]);
    },
    isBlocked: async () => blocked,
    ...over,
  });
  return { calls, routes };
}

export const PEPPER = "C".repeat(43);

/**
 * The sign-in and invite routes over a member world with CODE_PEPPER set and mail kept in the dev mailbox. Turnstile
 * passes and records each check's action; spend is `fakeSpend` unless `deps` replaces it, as it may any other dep.
 */
export async function authWorld(vars: Record<string, string> = {}, deps: Record<string, unknown> = {}) {
  const world = memberWorld({ CODE_PEPPER: PEPPER, DEV_MAILBOX: "1", ...vars });
  const spend = fakeSpend();
  const actions: string[] = [];
  const path = "../../src/worker/routes/auth.ts";
  const { authRoutesWith } = (await import(path)) as { authRoutesWith: (deps: object) => readonly AnyRoute[] };
  const routes = authRoutesWith({
    spend: () => spend,
    turnstile: async (_config: unknown, _token: string, check: { action: string }) => {
      actions.push(check.action);
      return { ok: true };
    },
    ...deps,
  });
  return { ...world, routes, spend, actions };
}

/** The public id of the session a cookie value names. */
export const publicId = async (db: TestDb, value: string) =>
  (
    db.raw.prepare("SELECT public_id FROM phone_session WHERE id_hash = ?").get(await sha256Hex(value)) as {
      public_id: string;
    }
  ).public_id;

export const cookieNames = (res: Response) => res.headers.getSetCookie().map((c) => c.split("=")[0]);

/**
 * Every declared rate-limit binding, recording `[name, key]` into `seen` (share it with a recording DB to check the
 * order) and refusing the names in `refuse`.
 */
export function recordingLimits(refuse: string[] = [], seen: [string, string][] = []) {
  const bindings = Object.fromEntries(
    Object.keys(declaredRateLimits()).map((name) => [
      name,
      {
        limit: async ({ key }: { key: string }) => {
          seen.push([name, key]);
          return { success: !refuse.includes(name) };
        },
      },
    ]),
  );
  return { seen, bindings };
}
