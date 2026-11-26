import type { ZodType } from "zod";
import { ERRORS } from "../../public/js/shared/errors.js";
import { APP_ERRORS } from "../../public/js/shared/errors-app.js";
import type { AppError, ErrorCode } from "../shared/protocol.ts";

/** The marker on every ok API answer: a client that gets a 200 without it is behind a filter's block page (REL-03). */
export const API_MARKER = { "X-Bloop": "1" };

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...API_MARKER, ...headers },
  });
}

/** The wait a 429 or 503 names when its caller has no better figure; the client treats it as a floor. */
const DEFAULT_RETRY_AFTER_SECONDS = 10;

/**
 * Every error response is application/problem+json with an ErrorCode or AppError and nothing else. A 429 or 503 always
 * carries `Retry-After` in whole seconds, at least 1.
 */
export function problem(
  status: number,
  code: ErrorCode | AppError,
  headers?: Record<string, string>,
  retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS,
): Response {
  const body = { type: "about:blank", status, code };
  const wait =
    status === 429 || status === 503 ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) } : {};
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json", ...wait, ...headers },
  });
}

/** A problem response whose status comes from the shared error table. */
export const fail = (
  code: ErrorCode | AppError,
  headers?: Record<string, string>,
  retryAfterSeconds?: number,
): Response =>
  problem(
    (code in ERRORS ? ERRORS[code as ErrorCode] : APP_ERRORS[code as AppError]).status,
    code,
    headers,
    retryAfterSeconds,
  );

/**
 * Checks every state-changing request must pass (PAIR-06): the Origin is ours, the browser says the
 * request is same-origin when it says anything, and the body is declared JSON, so a cross-site form
 * post is refused. Returns the refusal, or null.
 */
export function checkWrite(request: Request, origin: string): Response | null {
  const refused = checkOrigin(request, origin);
  if (refused) return refused;
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    return fail("unsupported_media_type");
  }
  return null;
}

/** Origin must equal PUBLIC_ORIGIN, and Sec-Fetch-Site must be same-origin when present. */
export function checkOrigin(request: Request, origin: string): Response | null {
  if (request.headers.get("Origin") !== origin) return fail("forbidden_origin");
  const site = request.headers.get("Sec-Fetch-Site");
  return site && site !== "same-origin" ? fail("forbidden_origin") : null;
}

const MAX_BODY_BYTES = 4096;

/**
 * The body as text, or null past MAX_BODY_BYTES: a declared length over it is refused unread, and a body without one
 * is read only until it passes the cap, so an oversized body is never buffered whole.
 */
async function boundedText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const body = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    body.set(value, size);
    size += value.byteLength;
  }
  return new TextDecoder().decode(body.subarray(0, size));
}

/**
 * Reads a small JSON body, `{}` when empty, and validates it. Unknown keys are refused by the schemas. `text` is the
 * body as sent, for a route that hashes it (the Idempotency-Key's body digest), so nothing reads the body twice.
 */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; value: T; text: string } | { ok: false; response: Response }> {
  const text = await boundedText(request);
  if (text === null) return { ok: false, response: fail("bad_request") };
  let body: unknown = {};
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, response: fail("bad_request") };
    }
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data, text } : { ok: false, response: fail("bad_request") };
}

/** The Bearer credential, or null when the header is missing or not a Bearer. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}
