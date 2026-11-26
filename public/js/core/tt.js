// The one Trusted Types policy. `new Worker(url)` and a script's `src` are script-URL sinks, and every page's CSP names
// this policy and no other (ADR 0020), so the only scripts a page can start are the ones listed here.

/** The exact worker script URLs the viewers may start. A viewer adds its own file here and nothing else can become a Worker. */
export const WORKER_URLS = new Set(/** @type {string[]} */ ([]));

/** Turnstile's loader, the one third-party script (ADR 0022): this exact URL, explicit rendering. */
export const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const allowed = (/** @type {string} */ url) => WORKER_URLS.has(url) || url === TURNSTILE_URL;

/** @type {{createScriptURL(url: string): string} | null | undefined} */
let policy;

/**
 * The URL as a Trusted Types script URL, or a thrown error when it is not listed. A browser without Trusted Types
 * takes the plain string: there is no sink check to satisfy.
 * @param {string} url
 * @returns {string}
 */
export function scriptUrl(url) {
  const factory = /** @type {any} */ (globalThis).trustedTypes;
  if (policy === undefined) {
    policy = factory
      ? factory.createPolicy("bloop-worker", {
          createScriptURL: (/** @type {string} */ u) => {
            if (!allowed(u)) throw new TypeError("script URL not allowed");
            return u;
          },
        })
      : null;
  }
  if (!allowed(url)) throw new TypeError("script URL not allowed");
  return policy ? policy.createScriptURL(url) : url;
}
