// The strings both sign-in pages share: the code step and the failure lines (docs/ux/signin.md, docs/ux/states.md).
// Each page's own strings sit beside it (copy-signin.js, copy-invite.js), so a page ships only what it shows; the
// pages' first paint repeats a few in the HTML, and test/unit/client-auth-copy.test.ts holds them equal.

/** "0:24": the resend countdown, from milliseconds left (rounded up, so it never shows 0:00). */
export const clock = (/** @type {number} */ ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const AUTH = {
  code: {
    title: "Check Your Email",
    ifSent: "If {email} has early access, a code is on its way.",
    sentTo: "A code is on its way to {masked}.",
    label: "Code",
    hint: "Enter the 6 digits from the email.",
    checking: "Checking...",
    other: "Use a Different Email",
    resend: "Send a New Code",
    resendIn: (/** @type {number} */ ms) => `Send a New Code in ${clock(ms)}`,
    wrong: "That code didn't match. Try again.",
    expired: "That code has expired. Send a new one.",
    tooMany: "Too many tries. Send a new code.",
    /** Over the per-address bucket; the wait is the server's Retry-After, never a constant. */
    tooManyCodes: (/** @type {number} */ seconds) => {
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      return `Too many codes for now. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    },
    cookies: "Your browser blocked sign-in. Allow cookies for bloop.here, then try again.",
  },
  offline: "You're offline. Check your connection, then try again.",
  slow: {
    still: "Still working. Keep this page open.",
    tooLong: "That took too long. Try again.",
  },
  /** `internal`, `service_busy` and any answer that is not one of the above (plan A section 6). */
  down: "bloop isn't responding. Try again in a minute.",
};

/**
 * Sets `el` to `template` with each `{name}` filled from `values` as ink 600 (`<strong>`) and the word bloop as the
 * body-copy name (design.md section 3). Text nodes only: no HTML string reaches the page.
 * @param {{ownerDocument: any, replaceChildren(...nodes: any[]): void}} el @param {string} template
 * @param {Record<string, string>} [values]
 */
export function fill(el, template, values = {}) {
  const make = (/** @type {string} */ tag, /** @type {object} */ props) =>
    Object.assign(el.ownerDocument.createElement(tag), props);
  el.replaceChildren(
    ...template.split(/(\{\w+\}|\bbloop\b)/).map((part) => {
      if (part === "bloop") return make("b", { className: "name", textContent: part });
      const key = /^\{(\w+)\}$/.exec(part)?.[1];
      return key === undefined ? part : make("strong", { textContent: values[key] ?? "" });
    }),
  );
}
