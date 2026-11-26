// Helpers every route module shares: configuration, the write checks, the platform rate limit, one
// call into a Screen object. Each handler: config, CSRF checks and Zod for writes (`write`, PAIR-06), rate limit, work.
import { z } from "zod";
import { testRelaxed } from "../auth/local.ts";
import { type Config, configFor } from "../config.ts";
import type { Env, RateLimitName } from "../env.ts";
import { bearer, checkWrite, fail, json, readJson } from "../http.ts";
import { hmacHex, parseCredential } from "../ids.ts";
import { network } from "../net.ts";
import type { Handler } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import { screenStub } from "../stubs.ts";

/** The body of a write that takes no input: `{}` or nothing, and no other key. */
export const emptyBody = z.object({}).strict();

export type WithConfig = (request: Request, env: Env, config: Config) => Response | Promise<Response>;

/** Fails closed with 500 when the configuration is invalid. */
export const withConfig =
  (handler: WithConfig): Handler =>
  (request, env) => {
    const config = configFor(env);
    if (!config.ok) {
      console.error(`config invalid: ${config.problems.join("; ")}`);
      return fail("internal");
    }
    return handler(request, env, config.config);
  };

export const respond = <T>(result: Result<T>, status = 200): Response =>
  result.ok ? json(result.value, status) : fail(result.error);

const clientIp = (request: Request): string => request.headers.get("CF-Connecting-IP") ?? "local";

/** Never stored raw: HMAC with the pepper. Local dev has no CF-Connecting-IP and shares one key. */
export const ipHash = (request: Request, config: Config): Promise<string> =>
  hmacHex(config.hashPepper, clientIp(request));

/** The same, of the client's network (an IPv6 /64), for caps one host could dodge by rotating addresses. */
export const netHash = (request: Request, config: Config): Promise<string> =>
  hmacHex(config.hashPepper, network(clientIp(request)));

const reported = new Set<RateLimitName>();

/**
 * Coarse platform limit, per pseudonymous IP unless the caller names another key (a session ref).
 * Skipped under TEST_TIMING on a local request. A missing binding fails closed for this route alone (the config-invalid 500), logged
 * once per name: the sweep and the Screen alarms never call this and must keep running.
 */
export async function limited(
  env: Env,
  name: RateLimitName,
  request: Request,
  config: Config,
  key?: string,
): Promise<Response | null> {
  if (testRelaxed(request, config)) return null;
  const binding: RateLimit | undefined = env[name];
  if (typeof binding?.limit !== "function") {
    if (!reported.has(name)) console.error(`rate-limit binding missing: ${name}`);
    reported.add(name);
    return fail("internal");
  }
  return (await binding.limit({ key: key ?? (await ipHash(request, config)) })).success ? null : fail("rate_limited");
}

/** A write route: checks, then the JSON body. */
export async function write<T>(
  request: Request,
  config: Config,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const refused = checkWrite(request, config.origin);
  return refused ? { ok: false, response: refused } : readJson(request, schema);
}

/** The Screen object a Bearer credential names, with the credential and its ref; null when it is not well formed. */
export function screenFor(request: Request, env: Env) {
  const value = bearer(request);
  const cred = value ? parseCredential(value) : null;
  return value && cred ? { stub: screenStub(env, cred.ref), credential: value, ref: cred.ref } : null;
}

/** Runs `call` against the Screen object a credential names, or answers 401. */
export async function withScreen<T>(
  request: Request,
  env: Env,
  call: (stub: ReturnType<typeof screenStub>, credential: string) => Promise<Result<T>>,
  ok: (value: T) => Response,
): Promise<Response> {
  const screen = screenFor(request, env);
  if (!screen) return fail("unauthorized");
  const result = await call(screen.stub, screen.credential);
  return result.ok ? ok(result.value) : fail(result.error);
}
