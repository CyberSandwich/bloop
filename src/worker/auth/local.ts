// Whether a request was made on this machine. Every TEST_TIMING or DEV_MAILBOX relaxation needs this as well as its
// flag, and config refuses either flag unless PUBLIC_ORIGIN is a local address, so a deployed Worker never relaxes.
import { isLocalOrigin } from "../config/core.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * A local hostname, and a client address that is absent or loopback. Behind Cloudflare's edge CF-Connecting-IP is the
 * real client address; `wrangler dev` sets it to the loopback caller. Trap: in front of `wrangler dev` nothing stops a
 * caller from omitting or forging the header, so a dev server exposed to the LAN is protected only by its 127.0.0.1
 * bind (`npm run dev`), never by this check.
 */
export function isLocalRequest(request: Request): boolean {
  const ip = request.headers.get("CF-Connecting-IP");
  return isLocalOrigin(request.url) && (ip === null || LOOPBACK.has(ip));
}

/** TEST_TIMING in force for this request. */
export const testRelaxed = (request: Request, config: { testTiming: boolean }): boolean =>
  config.testTiming && isLocalRequest(request);
