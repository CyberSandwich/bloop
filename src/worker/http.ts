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

/** Every error response is application/problem+json with an ErrorCode and nothing else. */
export function problem(status: number, code: ErrorCode | AppError, headers?: Record<string, string>): Response {
  const body = { type: "about:blank", status, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}

/** A problem response whose status comes from the shared error table. */
export const fail = (code: ErrorCode | AppError, headers?: Record<string, string>): Response =>
  problem((code in ERRORS ? ERRORS[code as ErrorCode] : APP_ERRORS[code as AppError]).status, code, headers);

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

/** Reads a small JSON body, `{}` when empty, and validates it. Unknown keys are refused by the schemas. */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: fail("bad_request") };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: fail("bad_request") };
  let body: unknown = {};
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, response: fail("bad_request") };
    }
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: fail("bad_request") };
}

/** The Bearer credential, or null when the header is missing or not a Bearer. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}
