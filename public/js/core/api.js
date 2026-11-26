// The one fetch wrapper: Bearer credentials in a header, JSON bodies, errors as ErrorCode.
// The browser adds Origin and Sec-Fetch-Site; every write declares application/json, which is what
// the Worker's CSRF check (PAIR-06) looks for.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
import { ERRORS } from "../shared/errors.js";
import { FETCH_TIMEOUT_MS } from "./timing.js";

/**
 * @template T
 * @typedef {{ok: true, value: T, headers: {get(name: string): string | null}}
 *   | {ok: false, error: ErrorCode, status?: number, code?: unknown, retryAfter?: number | undefined}} Reply status: bloop's HTTP answer, if any
 */

/** @param {unknown} code @returns {code is ErrorCode} */
export const isErrorCode = (code) => typeof code === "string" && Object.hasOwn(ERRORS, code);

/**
 * `appCodes`: pass on any code the Worker names, for the account pages, which carry their own copy per code
 * (errors-app.js) and read `error` as a string; the phone and screen pages keep to errors.js's.
 * @param {{fetch?: typeof fetch, appCodes?: boolean}} [deps]
 */
export function createApi(deps = {}) {
  const doFetch = deps.fetch ?? ((/** @type {Parameters<typeof fetch>} */ ...args) => globalThis.fetch(...args));
  /** @param {unknown} code @returns {code is ErrorCode} */
  const known = (code) => isErrorCode(code) || (!!deps.appCodes && typeof code === "string");

  /**
   * @param {"GET" | "POST" | "DELETE"} method
   * @param {string} path
   * @param {{auth?: string | null | undefined, body?: unknown, headers?: Record<string, string>, keepalive?: boolean,
   *   timeout?: boolean | number}} [options] true for FETCH_TIMEOUT_MS, or the milliseconds (true counts as 1)
   * @returns {Promise<Reply<any>>}
   */
  async function call(method, path, options = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json", ...options.headers };
    if (options.auth) headers.Authorization = `Bearer ${options.auth}`;
    /** @type {RequestInit} */
    const init = {
      method,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      keepalive: !!options.keepalive,
    };
    // Writes wait (a slow approve lands), bar the remote's. No AbortSignal.timeout (Safari 15.4).
    const stop = new AbortController();
    let timer;
    if (method === "GET" || options.timeout) {
      timer = setTimeout(() => stop.abort(), typeof options.timeout === "number" ? options.timeout : FETCH_TIMEOUT_MS);
      init.signal = stop.signal;
    }
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body ?? {});
    }
    let res;
    let body = null;
    try {
      res = await doFetch(path, init);
      body = JSON.parse((await res.text()) || "{}");
    } catch {
      // No answer, or one that is not JSON (body stays null)
      if (!res) return { ok: false, error: "offline" };
    } finally {
      clearTimeout(timer);
    }
    // A 200 that is not ours (no marker, or not JSON) is a filter's block page: the network, not bloop (REL-03).
    if (res.ok)
      return body === null || res.headers.get("X-Bloop") !== "1"
        ? { ok: false, error: "network_blocked" }
        : { ok: true, value: body, headers: res.headers };
    const code = body?.code;
    // Retry-After in whole seconds (an HTTP date is not honored).
    const after = Number(res.headers.get("Retry-After"));
    const error = known(code) ? code : res.status >= 500 || body === null ? "service_down" : "bad_request";
    // The library's own codes are not in ERRORS: their pages read `code`.
    return { ok: false, error, status: res.status, code, retryAfter: after || undefined };
  }

  return {
    call,
    /** @param {string} path @param {string | null} [auth] */
    get: (path, auth) => call("GET", path, { auth }),
    /** @param {string} path @param {unknown} [body] @param {string | null} [auth] @param {boolean} [timeout] */
    post: (path, body, auth, timeout = false) => call("POST", path, { body, auth, timeout }),
    /** A POST that outlives the page. @param {string} path @param {string | null} [auth] */
    leave: (path, auth) => call("POST", path, { auth, keepalive: true }),
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */
