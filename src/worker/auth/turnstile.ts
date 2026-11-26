// Turnstile siteverify (ADR 0022). Friction against scripted requests, never the only limit: RL bindings stay, since
// Cloudflare's duplicate-token detection is eventually consistent. Every failure, including a timeout, fails closed.
import { testRelaxed } from "./local.ts";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TurnstileConfig {
  origin: string;
  testTiming: boolean;
  secrets: { turnstileSecret: string | null };
}

export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "bad_key" | "unreachable" | "rejected" | "action" | "hostname" };

export interface TurnstileCheck {
  request: Request;
  action: string;
  /**
   * Only for a server-side retry of this same check, so the retry does not read as a reused token. Never a value the
   * client sent; anything but a UUID is refused. Absent, a fresh one is drawn.
   */
  idempotencyKey?: string;
}

/**
 * TRANSITIONAL(a-4): the code request route is the first caller.
 *
 * `action` must match the widget's (a token made for the report form cannot sign in), and `hostname` must be
 * PUBLIC_ORIGIN's. Cloudflare's test secret answers hostname example.com and no action (its docs), so under TEST_TIMING
 * on a local request the hostname check is skipped and a missing or empty action is accepted, never a different one.
 */
export async function verifyTurnstile(
  config: TurnstileConfig,
  token: string,
  check: TurnstileCheck,
  fetcher: typeof fetch = fetch,
): Promise<TurnstileVerdict> {
  const secret = config.secrets.turnstileSecret;
  if (!secret) return { ok: false, reason: "no_secret" };
  const key = check.idempotencyKey ?? crypto.randomUUID();
  if (!UUID.test(key)) return { ok: false, reason: "bad_key" };
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  form.set("idempotency_key", key);
  const ip = check.request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  let body: { success?: unknown; action?: unknown; hostname?: unknown };
  try {
    const res = await fetcher(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const parsed: unknown = await res.json();
    body = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (body.success !== true) return { ok: false, reason: "rejected" };
  const relaxed = testRelaxed(check.request, config);
  const testAnswer = relaxed && (body.action === undefined || body.action === "");
  if (body.action !== check.action && !testAnswer) return { ok: false, reason: "action" };
  if (!relaxed && body.hostname !== new URL(config.origin).hostname) return { ok: false, reason: "hostname" };
  return { ok: true };
}
