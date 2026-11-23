import type { ErrorCode } from "../shared/protocol.ts";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Every error response is application/problem+json with an ErrorCode and nothing else. */
export function problem(status: number, code: ErrorCode, headers?: HeadersInit): Response {
  const body = { type: "about:blank", status, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}
