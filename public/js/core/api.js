// The one fetch wrapper: Bearer credentials in a header, JSON bodies, errors as ErrorCode.
// The browser adds Origin and Sec-Fetch-Site; every write declares application/json, which is what
// the Worker's CSRF check (PAIR-06) looks for.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
import { ERRORS } from "../shared/errors.js";

/**
 * @template T
 * @typedef {{ok: true, value: T, headers: {get(name: string): string | null}} | {ok: false, error: ErrorCode}} Reply
 */

/** @param {unknown} code @returns {code is ErrorCode} */
const isErrorCode = (code) => typeof code === "string" && Object.hasOwn(ERRORS, code);

/**
 * @param {{fetch?: typeof fetch}} [deps]
 */
export function createApi(deps = {}) {
  const doFetch = deps.fetch ?? ((/** @type {Parameters<typeof fetch>} */ ...args) => globalThis.fetch(...args));

  /**
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {{auth?: string | null | undefined, body?: unknown, keepalive?: boolean}} [options]
   * @returns {Promise<Reply<any>>}
   */
  async function call(method, path, options = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" };
    if (options.auth) headers.Authorization = `Bearer ${options.auth}`;
    /** @type {RequestInit} */
    const init = { method, headers, cache: "no-store", credentials: "same-origin", keepalive: !!options.keepalive };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body ?? {});
    }
    let res;
    try {
      res = await doFetch(path, init);
    } catch {
      return { ok: false, error: "offline" };
    }
    let body = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      body = null;
    }
    if (res.ok)
      return body === null ? { ok: false, error: "service_down" } : { ok: true, value: body, headers: res.headers };
    const code = body?.code;
    if (isErrorCode(code)) return { ok: false, error: code };
    return { ok: false, error: res.status >= 500 || body === null ? "service_down" : "bad_request" };
  }

  return {
    call,
    /** @param {string} path @param {string | null} [auth] */
    get: (path, auth) => call("GET", path, { auth }),
    /** @param {string} path @param {unknown} [body] @param {string | null} [auth] */
    post: (path, body, auth) => call("POST", path, { body, auth }),
    /** A POST that outlives the page. @param {string} path @param {string | null} [auth] */
    leave: (path, auth) => call("POST", path, { auth, keepalive: true }),
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */
