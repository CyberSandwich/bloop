// Helpers every route module shares: configuration, the write checks, the platform rate limit, one
// call into a Screen object. Each handler: config, CSRF checks for writes (PAIR-06), rate limit, Zod, work.
import type { z } from "zod";
import { type Config, configFor } from "../config.ts";
import type { Env } from "../env.ts";
import { bearer, checkWrite, fail, json, readJson } from "../http.ts";
import { hmacHex, parseCredential } from "../ids.ts";
import type { Handler } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import { screenStub } from "../stubs.ts";

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

/** Never stored raw: HMAC with the pepper. Local dev has no CF-Connecting-IP and shares one key. */
export const ipHash = (request: Request, config: Config): Promise<string> =>
  hmacHex(config.hashPepper, request.headers.get("CF-Connecting-IP") ?? "local");

/** Coarse platform limit per pseudonymous IP. Skipped when the binding is absent or under TEST_TIMING. */
export async function limited(
  binding: RateLimit | undefined,
  request: Request,
  config: Config,
): Promise<Response | null> {
  if (config.testTiming || typeof binding?.limit !== "function") return null;
  const key = await ipHash(request, config);
  return (await binding.limit({ key })).success ? null : fail("rate_limited");
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

/** The Screen object a Bearer credential names, with the credential; null when it is not well formed. */
export function screenFor(request: Request, env: Env) {
  const value = bearer(request);
  const cred = value ? parseCredential(value) : null;
  return value && cred ? { stub: screenStub(env, cred.ref), credential: value } : null;
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
