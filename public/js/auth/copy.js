// Every user-facing string of /signin and /invite (docs/ux/signin.md, docs/ux/states.md), one object. The pages'
// first paint repeats a few of them in the HTML; test/unit/client-auth-copy.test.ts holds the two equal.

/** "0:24": the resend countdown, from milliseconds left (rounded up, so it never shows 0:00). */
export const clock = (/** @type {number} */ ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const AUTH = {
  signin: {
    title: "Sign In",
    lead: "Early access is by invite. Use the email your invite went to.",
    email: "Email",
    send: "Email Me a Code",
    waitlist: "No invite? Join the waitlist.",
  },
  turnstile: {
    checking: "Checking...",
    blocked: "Turn off content blocking for bloop.here to sign in.",
    retry: "Try Again",
  },
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
    wrong: "That code didn't match. Check the email and try again.",
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
  invite: {
    title: "You're Invited",
    to: "Early access to bloop for {masked}.",
    about: "bloop puts your files on the room screen from your phone. The screen never gets your account.",
    until: "The invite works until {date}.",
    accept: "Accept Invite",
    adult: "By continuing you confirm you are 18 or over and accept the Terms.",
    signedInAs: "You're Signed In as {masked}",
    forOther: "This invite is for {masked}.",
    signOut: "Sign Out and Continue",
    library: "Go to Your Library",
    home: "Go to the Home Page",
    signIn: "Sign In",
    retry: "Try Again",
  },
  /** The peek states and the load failures, each a dead end with at most one exit (docs/ux/signin.md section 5). */
  dead: {
    expired: { title: "This Invite Has Expired", line: "Ask the person who invited you for a new one.", exit: "home" },
    used: { title: "This Invite Was Already Used", line: "Sign in with the email it went to.", exit: "signin" },
    invalid: { title: "This Invite Isn't Valid", line: "Check you opened the newest invite email.", exit: "home" },
    none: { title: "Open Your Invite Email", line: "Tap the link in the email to accept.", exit: "home" },
    limited: { title: "Too Many Tries Right Now", line: "Wait a minute, then open the link again.", exit: null },
    offline: { title: "You're Offline", line: "Check your connection, then try again.", exit: "retry" },
    down: { title: "bloop Isn't Responding", line: "Try again in a minute.", exit: "retry" },
  },
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
