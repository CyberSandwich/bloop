// The library's fetch wrapper: cookie credentials, JSON both ways, the server's own code on a refusal, and 304 kept as
// "nothing changed". core/api.js is the pairing pages' (Bearer, their error table); the library needs PATCH, PUT,
// If-None-Match and the app codes, and only reads the code it is given.
// transitional: U: U's core/api.js replaces this once it lands, if it passes a failure's body and drops shared/errors.js,
// which alone would put this page over its size limit.
import { FETCH_TIMEOUT_MS } from "../core/timing.js";

/**
 * @typedef {{ok: true, status: number, value: any, headers: {get(name: string): string | null}}
 *   | {ok: false, status: number, code: string, body: any}} Answer
 */

/** @param {{fetch?: typeof fetch, timeoutMs?: number}} [deps] */
export function createNet(deps = {}) {
  const doFetch = deps.fetch ?? ((/** @type {Parameters<typeof fetch>} */ ...args) => globalThis.fetch(...args));
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;

  /**
   * @param {"GET" | "POST" | "PATCH" | "PUT" | "DELETE"} method
   * @param {string} path
   * @param {unknown} [body] sent as JSON on every method but GET
   * @param {Record<string, string>} [extra]
   * @returns {Promise<Answer>}
   */
  async function call(method, path, body, extra = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json", ...extra };
    /** @type {RequestInit} */
    const init = { method, headers, cache: "no-store", credentials: "same-origin" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    // A read gives up after the timeout and counts as offline; a write waits, since it may have landed.
    const stop = new AbortController();
    const timer = method === "GET" ? setTimeout(() => stop.abort(), timeoutMs) : undefined;
    init.signal = stop.signal;
    let res;
    let text = "";
    try {
      res = await doFetch(path, init);
      text = await res.text();
    } catch {
      return { ok: false, status: 0, code: "offline", body: null };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304) return { ok: true, status: 304, value: null, headers: res.headers };
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    // A 200 that is not JSON is a filter's page, not bloop's answer (REL-03).
    if (res.ok) {
      return parsed === null
        ? { ok: false, status: res.status, code: "network_blocked", body: null }
        : { ok: true, status: res.status, value: parsed, headers: res.headers };
    }
    const code = typeof parsed?.code === "string" ? parsed.code : res.status >= 500 ? "service_down" : "bad_request";
    return { ok: false, status: res.status, code, body: parsed };
  }

  return { call };
}

/** @typedef {ReturnType<typeof createNet>} Net */
