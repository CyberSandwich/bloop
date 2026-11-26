// Turnstile (ADR 0022), loaded on intent (the first keystroke or tap on the email field): Cloudflare's script through
// the one Trusted Types policy, then one widget that runs only when asked and shows its own box only when it needs a
// person.

/** @typedef {{render(box: HTMLElement, options: object): string, execute(id: string): void, reset(id: string): void}} Api */

/** @type {Promise<Api> | undefined} */
let loading;

/** The script, once; a failed load (a blocker, offline) is forgotten, so Try Again fetches it again. */
function load() {
  loading ??= (async () => {
    const { TURNSTILE_URL, scriptUrl } = await import("../core/tt.js");
    await new Promise((done, fail) => {
      const script = document.createElement("script");
      script.onload = done;
      script.onerror = () => {
        script.remove();
        fail(new Error("turnstile blocked"));
      };
      script.async = true;
      script.src = scriptUrl(TURNSTILE_URL);
      document.head.append(script);
    });
    const api = /** @type {any} */ (globalThis).turnstile;
    if (!api) throw new Error("turnstile missing");
    return /** @type {Api} */ (api);
  })().catch((e) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

/**
 * The invisible widget in `box`, or a rejection when the script cannot load. `token()` resolves with a fresh,
 * single-use token (siteverify takes each once), or rejects when the challenge errors, times out or its token
 * expires unused, so no wait is endless. `person` hears when a challenge needs a person and when it is done.
 * @param {HTMLElement} box @param {string} sitekey @param {string} action
 * @param {{pause: () => void, resume: () => void}} person
 */
export async function widget(box, sitekey, action, person) {
  const api = await load();
  /** @type {{ok: (token: string) => void, no: (e: Error) => void} | null} */
  let waiting = null;
  let used = false;
  const refuse = (/** @type {string} */ why) => () => {
    waiting?.no(new Error(why));
    return true;
  };
  const id = api.render(box, {
    sitekey,
    action,
    execution: "execute",
    appearance: "interaction-only",
    callback: (/** @type {string} */ token) => waiting?.ok(token),
    "error-callback": refuse("turnstile error"),
    "timeout-callback": refuse("turnstile timeout"),
    "expired-callback": refuse("turnstile expired"),
    "before-interactive-callback": person.pause,
    "after-interactive-callback": person.resume,
  });
  return {
    /** @returns {Promise<string>} */
    token: () =>
      new Promise((ok, no) => {
        waiting = { ok, no };
        if (used) api.reset(id);
        used = true;
        api.execute(id);
      }),
  };
}
