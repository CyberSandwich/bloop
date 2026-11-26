// /signin: the email step, then the code step (docs/ux/signin.md sections 1 and 2). Passkeys come with
// core/webauthn.js; until then the page offers none, so nothing on it depends on a passkey route.
/** @import {Hold, Row} from "./auth/row.js" */
import { AUTH, fill } from "./auth/copy.js";
import { SIGNIN } from "./auth/copy-signin.js";
import { createRow, nextFrom, quietSkip, showFailure, watch } from "./auth/row.js";
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
/** The slow rule of the send in flight; Turnstile pauses it while a person solves a challenge. */
/** @type {Hold} */
let hold = {};
/** The code request in flight, so a resubmit after the stop waits for it instead of mailing a second code. */
/** @type {{to: string, reply: Promise<import("./auth/row.js").Reply>} | null} */
let inflight = null;

/** Turnstile on intent: its module, its script and the site key, fetched together once. */
/** @type {Promise<{token: () => Promise<string>} | null> | undefined} */
let guard;
function turnstile() {
  guard ??= (async () => {
    const [me, mod] = await Promise.all([api.get("/api/me"), import("./auth/turnstile.js")]);
    // A failed read is forgotten with the rest, so Try Again asks again.
    if (!me.ok) throw new Error(me.error);
    const key = me.value.turnstileSiteKey;
    const person = { pause: () => hold.pause?.(), resume: () => hold.resume?.() };
    return typeof key === "string" && key ? mod.widget(byId("ts-box"), key, "signin", person) : null;
  })().catch((e) => {
    guard = undefined;
    throw e;
  });
  return guard;
}

/** The code step, loaded on intent beside Turnstile and bound once. */
/** @type {Promise<{start: (answer: unknown) => void, stop: () => void}> | undefined} */
let codeStep;
function code() {
  codeStep ??= import("./auth/code-entry.js")
    .then(({ createCodeEntry, land }) =>
      createCodeEntry(
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
          refused: (reply) => turnstileRefusal(reply, codeRow),
        },
      ),
    )
    .catch((e) => {
      codeStep = undefined;
      throw e;
    });
  return codeStep;
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
  setText(byId("send-text"), on ? SIGNIN.checking : SIGNIN.send);
  gate();
}

/** The content-blocking line, in the row of the step that asked; Try Again sits on the email step. */
function blocked(/** @type {Row} */ row) {
  row.alert(SIGNIN.blocked);
  show(retry, row === emailRow);
}

/** A Turnstile refusal in `row`: a blocked script is content blocking, a timed-out challenge only took too long. */
function turnstileRefusal(/** @type {{error: string}} */ reply, /** @type {Row} */ row) {
  if (reply.error === "turnstile_failed") blocked(row);
  else if (reply.error === "turnstile_timeout") row.alert(AUTH.slow.tooLong);
  else return false;
  return true;
}

/**
 * The code request, Turnstile first. The server takes no request without a token, so with no site key configured
 * nothing is sent and bloop reads as not responding; a script that cannot load answers as the server's
 * `turnstile_failed`, and a challenge that timed out or expired as the slow rule's stop.
 * @param {Hold} [held] the slow rule of the caller's watch, paused while a person solves a challenge
 */
async function request(held = hold) {
  hold = held;
  let token = "";
  try {
    const ts = await turnstile();
    if (!ts) return { ok: /** @type {const} */ (false), error: "service_down" };
    token = await ts.token();
  } catch (e) {
    const late = e instanceof Error && /timeout|expired/.test(e.message);
    return { ok: /** @type {const} */ (false), error: late ? "turnstile_timeout" : "turnstile_failed" };
  }
  const reply = await api.post("/api/auth/code/request", { email: email.value.trim(), turnstile: token });
  if (reply.ok) challengeId = reply.value.challengeId;
  return reply;
}

function showStep(/** @type {"email" | "code"} */ step) {
  const onCode = step === "code";
  show(emailForm, !onCode);
  show(codeForm, onCode);
  show(send, !onCode);
  show(resend, onCode);
  show(byId("waitlist"), !onCode);
  setText(title, onCode ? AUTH.code.title : SIGNIN.title);
  if (onCode) fill(lead, AUTH.code.ifSent, { email: email.value.trim() });
  else {
    codeStep?.then((c) => c.stop()).catch(() => {});
    setText(lead, SIGNIN.lead);
  }
  focusTitle(title);
}

/** Intent, not focus: the page focuses the field itself, and a visit that only looks loads nothing from Cloudflare. */
const INTENT = ["pointerdown", "keydown", "input"];
function intent() {
  for (const type of INTENT) email.removeEventListener(type, intent);
  turnstile().catch(() => blocked(emailRow));
  code().catch(() => {});
}
for (const type of INTENT) email.addEventListener(type, intent);
email.addEventListener("input", gate);
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
  const to = email.value.trim();
  hold = {};
  if (inflight?.to !== to) {
    const mine = { to, reply: request(hold) };
    inflight = mine;
    mine.reply.finally(() => {
      if (inflight === mine) inflight = null;
    });
  }
  let stopped = false;
  const reply = await watch(
    /** @type {NonNullable<typeof inflight>} */ (inflight).reply,
    {
      slow: () => emailRow.status(AUTH.slow.still, true),
      stop: () => {
        stopped = true;
        busy(false);
        emailRow.alert(AUTH.slow.tooLong);
      },
    },
    undefined,
    hold,
  );
  // A code sent after the stop still opens the code step: the email is on its way.
  if (stopped && !reply.ok) return;
  busy(false);
  if (reply.ok) {
    let step;
    try {
      step = await code();
    } catch {
      showFailure({ error: "offline" }, emailRow);
      return;
    }
    emailRow.clear();
    // One history entry: Back on the code step returns here, never off the site.
    history.pushState({ step: "code" }, "");
    showStep("code");
    step.start(reply.value);
  } else if (reply.error === "email_invalid") {
    // The browser accepted it, the normalizer did not: the lead line already says which address to use.
    emailRow.clear();
    email.setAttribute("aria-invalid", "true");
    email.focus();
  } else if (!turnstileRefusal(reply, emailRow)) showFailure(reply, emailRow);
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
quietSkip(document, () => focusTitle(title));

// A reload on the code step has lost its challenge: the email step.
if (history.state?.step === "code") history.replaceState(null, "");
gate();
// Arriving from a redirect (a page that asked for sign-in) lands on the title; a typed visit starts typing.
if (new URLSearchParams(location.search).has("next")) focusTitle(title);
else email.focus();
