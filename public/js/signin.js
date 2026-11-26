// /signin: the email step, then the code step (docs/ux/signin.md sections 1 and 2). Passkeys come with
// core/webauthn.js; until then the page offers none, so nothing on it depends on a passkey route.
/** @import {Row} from "./auth/code-entry.js" */
import { createCodeEntry, createRow, expiryOf, land, nextFrom, showFailure, watch } from "./auth/code-entry.js";
import { AUTH, fill } from "./auth/copy.js";
import { createApi } from "./core/api.js";
import { byId, focusTitle, setText, show } from "./core/ui.js";

const api = createApi({ appCodes: true });
const next = nextFrom(location.search);

const title = byId("title");
const lead = byId("lead");
const emailForm = byId("email-form");
const email = /** @type {HTMLInputElement} */ (byId("email"));
const codeForm = byId("code-form");
const send = /** @type {HTMLButtonElement} */ (byId("send"));
const resend = /** @type {HTMLButtonElement} */ (byId("resend"));
const retry = byId("ts-retry");
const rowOf = (/** @type {string} */ id) =>
  createRow({
    hint: byId(`${id}-hint`),
    hintText: byId(`${id}-hint-text`),
    error: byId(`${id}-error`),
    errorText: byId(`${id}-error-text`),
  });
const emailRow = rowOf("email");
const codeRow = rowOf("code");

/** @type {string | null} */
let challengeId = null;
let sending = false;

/** Turnstile on intent: its module, its script and the site key are fetched on the email field's first focus. */
/** @type {Promise<{token: () => Promise<string>} | null> | undefined} */
let guard;
function turnstile() {
  guard ??= (async () => {
    const [me, mod] = await Promise.all([api.get("/api/me"), import("./auth/turnstile.js")]);
    const key = me.ok ? me.value.turnstileSiteKey : null;
    // No key configured (a local build): the request goes without a token and the server decides.
    return typeof key === "string" && key ? mod.widget(byId("ts-box"), key, "signin") : null;
  })().catch((e) => {
    guard = undefined;
    throw e;
  });
  return guard;
}

/**
 * Email Me a Code is enabled once the browser's own email check passes, and never while a request runs; an edit
 * clears the server's refusal.
 */
function gate() {
  send.disabled = sending || !email.checkValidity();
  email.removeAttribute("aria-invalid");
}

function busy(/** @type {boolean} */ on) {
  sending = on;
  /** @type {HTMLElement} */ (send.querySelector(".spinner")).hidden = !on;
  setText(byId("send-text"), on ? AUTH.turnstile.checking : AUTH.signin.send);
  gate();
}

/** The content-blocking line, in the row of the step that asked; Try Again sits on the email step. */
function blocked(/** @type {Row} */ row) {
  row.alert(AUTH.turnstile.blocked);
  show(retry, row === emailRow);
}

/** The code request, Turnstile first; a token that cannot be had answers as the server's `turnstile_failed`. */
async function request() {
  let token = "";
  try {
    const ts = await turnstile();
    if (ts) token = await ts.token();
  } catch {
    return { ok: /** @type {const} */ (false), error: "turnstile_failed" };
  }
  const reply = await api.post("/api/auth/code/request", { email: email.value.trim(), turnstile: token });
  if (reply.ok) challengeId = reply.value.challengeId;
  return reply;
}

const code = createCodeEntry(
  { input: /** @type {HTMLInputElement} */ (byId("code")), row: codeRow, resend, doc: document },
  {
    verify: (digits) => api.post("/api/auth/code/verify", { challengeId, code: digits }),
    resend: request,
    done: () =>
      land(
        () => api.get("/api/me"),
        next,
        codeRow,
        (path) => location.assign(path),
      ),
    refused: (reply) => {
      if (reply.error !== "turnstile_failed") return false;
      blocked(codeRow);
      return true;
    },
  },
);

function showStep(/** @type {"email" | "code"} */ step) {
  const onCode = step === "code";
  show(emailForm, !onCode);
  show(codeForm, onCode);
  show(send, !onCode);
  show(resend, onCode);
  show(byId("waitlist"), !onCode);
  setText(title, onCode ? AUTH.code.title : AUTH.signin.title);
  if (onCode) fill(lead, AUTH.code.ifSent, { email: email.value.trim() });
  else {
    code.stop();
    setText(lead, AUTH.signin.lead);
  }
  focusTitle(title);
}

email.addEventListener("input", gate);
email.addEventListener("focus", () => turnstile().catch(() => blocked(emailRow)), { once: true });
retry.addEventListener("click", () => {
  show(retry, false);
  emailRow.clear();
  turnstile().catch(() => blocked(emailRow));
});

emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending || !email.checkValidity()) return;
  emailRow.clear();
  show(retry, false);
  busy(true);
  let stopped = false;
  const reply = await watch(request(), {
    slow: () => emailRow.status(AUTH.slow.still, true),
    stop: () => {
      stopped = true;
      busy(false);
      emailRow.alert(AUTH.slow.tooLong);
    },
  });
  // A code sent after the stop still opens the code step: the email is on its way.
  if (stopped && !reply.ok) return;
  busy(false);
  if (reply.ok) {
    emailRow.clear();
    // One history entry: Back on the code step returns here, never off the site.
    history.pushState({ step: "code" }, "");
    showStep("code");
    code.start(expiryOf(reply.value.expiresAt));
  } else if (reply.error === "email_invalid") {
    // The browser accepted it, the normalizer did not: the lead line already says which address to use.
    emailRow.clear();
    email.setAttribute("aria-invalid", "true");
    email.focus();
  } else if (reply.error === "turnstile_failed") blocked(emailRow);
  else showFailure(reply, emailRow);
});

// Back (or Forward into a step whose timers are gone) is the email step, the field filled and selected.
addEventListener("popstate", () => {
  if (history.state?.step === "code") history.replaceState(null, "");
  showStep("email");
  email.focus();
  email.select();
});
byId("other").addEventListener("click", () => history.back());
byId("back").addEventListener("click", (e) => {
  if (codeForm.hidden) return;
  e.preventDefault();
  history.back();
});

// A reload on the code step has lost its challenge: the email step.
if (history.state?.step === "code") history.replaceState(null, "");
gate();
// Arriving from a redirect (a page that asked for sign-in) lands on the title; a typed visit starts typing.
if (new URLSearchParams(location.search).has("next")) focusTitle(title);
else email.focus();
