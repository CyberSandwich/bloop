// The one Trusted Types policy. `new Worker(url)` is a script-URL sink, and every page's CSP names this policy and no
// other (ADR 0020), so the only Workers a page can start are the ones listed here.

/** The exact worker script URLs the viewers may start. A viewer adds its own file here and nothing else can become a Worker. */
export const WORKER_URLS = new Set(/** @type {string[]} */ ([]));

/** @type {{createScriptURL(url: string): string} | null | undefined} */
let policy;

/**
 * The worker URL as a Trusted Types script URL, or a thrown error when it is not listed. A browser without Trusted
 * Types takes the plain string: there is no sink check to satisfy.
 * @param {string} url
 * @returns {string}
 */
export function workerUrl(url) {
  const factory = /** @type {any} */ (globalThis).trustedTypes;
  if (policy === undefined) {
    policy = factory
      ? factory.createPolicy("bloop-worker", {
          createScriptURL: (/** @type {string} */ u) => {
            if (!WORKER_URLS.has(u)) throw new TypeError("worker URL not allowed");
            return u;
          },
        })
      : null;
  }
  if (!WORKER_URLS.has(url)) throw new TypeError("worker URL not allowed");
  return policy ? policy.createScriptURL(url) : url;
}
