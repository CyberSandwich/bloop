// Turnstile siteverify (ADR 0022). Friction against scripted requests, never the only limit: RL bindings stay, since
// Cloudflare's duplicate-token detection is eventually consistent. Every failure, including a timeout, fails closed.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

export interface TurnstileConfig {
  origin: string;
  testTiming: boolean;
  secrets: { turnstileSecret: string | null };
}

export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "unreachable" | "rejected" | "action" | "hostname" };

/**
 * `action` must match the widget's (a token made for the report form cannot sign in), and `hostname` must be
 * PUBLIC_ORIGIN's. Cloudflare's test keys answer hostname example.com and no action, so TEST_TIMING skips the hostname
 * check and accepts a missing action, never a different one. `idempotencyKey` (a UUID) lets a retry of the same check
 * succeed instead of reading as a reused token.
 */
export async function verifyTurnstile(
  config: TurnstileConfig,
  token: string,
  request: { ip: string | null; action: string; idempotencyKey: string },
  fetcher: typeof fetch = fetch,
): Promise<TurnstileVerdict> {
  const secret = config.secrets.turnstileSecret;
  if (!secret) return { ok: false, reason: "no_secret" };
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  form.set("idempotency_key", request.idempotencyKey);
  if (request.ip) form.set("remoteip", request.ip);
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
  const testAnswer = config.testTiming && body.action === undefined;
  if (body.action !== request.action && !testAnswer) return { ok: false, reason: "action" };
  if (!config.testTiming && body.hostname !== new URL(config.origin).hostname) return { ok: false, reason: "hostname" };
  return { ok: true };
}
