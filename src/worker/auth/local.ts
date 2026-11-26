// Whether a request was made on this machine. Every TEST_TIMING or DEV_MAILBOX relaxation needs this as well as its
// flag, so a flag that somehow reached a deployed Worker still relaxes nothing.
import { isLocalOrigin } from "../config/core.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * A local hostname, and a client address that is absent or loopback. Cloudflare's edge always sets CF-Connecting-IP
 * to the real client address, which is never loopback; `wrangler dev` sets it to the loopback caller.
 */
export function isLocalRequest(request: Request): boolean {
  const ip = request.headers.get("CF-Connecting-IP");
  return isLocalOrigin(request.url) && (ip === null || LOOPBACK.has(ip));
}

/** TEST_TIMING in force for this request. */
export const testRelaxed = (request: Request, config: { testTiming: boolean }): boolean =>
  config.testTiming && isLocalRequest(request);
