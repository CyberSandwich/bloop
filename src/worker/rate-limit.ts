// The platform rate limit's one call, typed without the Worker's Env, so the page gate (which Node-side tests import)
// spends it the way every route does (`limited` in routes/common.ts).
import { testRelaxed } from "./auth/local.ts";
import type { Config } from "./config.ts";
import { fail } from "./http.ts";
import { hmacHex } from "./ids.ts";

/** The slice of a rate-limit binding this calls. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export const clientIp = (request: Request): string => request.headers.get("CF-Connecting-IP") ?? "local";

/** Never stored raw: HMAC with the pepper. Local dev has no CF-Connecting-IP and shares one key. */
export const ipHash = (request: Request, config: Config): Promise<string> =>
  hmacHex(config.hashPepper, clientIp(request));

const reported = new Set<string>();

/**
 * Coarse platform limit, per pseudonymous IP unless the caller names another key (a session ref).
 * Skipped under TEST_TIMING on a local request. A missing binding fails closed for this route alone (the config-invalid 500), logged
 * once per name: the sweep and the Screen alarms never call this and must keep running.
 */
export async function spendLimit(
  binding: Limiter | undefined,
  name: string,
  request: Request,
  config: Config,
  key?: string,
): Promise<Response | null> {
  if (testRelaxed(request, config)) return null;
  if (typeof binding?.limit !== "function") {
    if (!reported.has(name)) console.error(`rate-limit binding missing: ${name}`);
    reported.add(name);
    return fail("internal");
  }
  return (await binding.limit({ key: key ?? (await ipHash(request, config)) })).success ? null : fail("rate_limited");
}
