// /invite#t=<token>: peek, then Accept, then the code step, then the library (docs/ux/signin.md section 5). The token
// lives only in the fragment, which never reaches a server; the page drops it from the address before any request.
import { createCodeEntry, createRow, expiryOf, land } from "./auth/code-entry.js";
import { AUTH, fill } from "./auth/copy.js";
import { createApi } from "./core/api.js";
import { sessionStore } from "./core/store.js";
import { byId, focusTitle, setText, show } from "./core/ui.js";

/** Holds the token while Terms is open in this tab, so Back resumes the invite. */
const KEPT = "bloop.invite";
const api = createApi({ appCodes: true });
const store = sessionStore();
const title = byId("title");
const codeForm = byId("code-form");
const row = createRow({
  hint: byId("code-hint"),
  hintText: byId("code-hint-text"),
  error: byId("code-error"),
  errorText: byId("code-error-text"),
});

const hash = location.hash;
if (hash) history.replaceState(null, "", location.pathname);
const token = hash ? (/^#t=(.*)$/.exec(hash)?.[1] ?? "") : (store.get(KEPT) ?? "");
store.remove(KEPT);

/** The address as the server masks it (auth/invites.ts `maskEmail`): the first letter, `**`, then the domain. */
const masked = (/** @type {string} */ email) => `${email[0]}**${email.slice(email.lastIndexOf("@"))}`;

/** @type {string | null} */
let challengeId = null;
/** @type {{emailMasked: string, expiresAt: unknown} | null} */
let invite = null;

/**
 * One state: its title, its line (a copy template and its values), and only the exits named.
 * @param {string} heading @param {string} line @param {Record<string, string>} values @param {string[]} exits
 * @param {{about?: boolean, until?: string, code?: boolean, dead?: boolean}} [more]
 */
function state(heading, line, values, exits, more = {}) {
  show(byId("skel-title"), false);
  show(title, true);
  setText(title, heading);
  fill(byId("lead"), line, values);
  show(byId("about"), !!more.about);
  show(byId("until"), !!more.until);
  if (more.until) fill(byId("until"), AUTH.invite.until, { date: more.until });
  show(codeForm, !!more.code);
  show(byId("adult"), exits.includes("accept"));
  for (const id of ["to-library", "accept", "sign-out", "home", "to-signin", "retry", "resend"])
    show(byId(id), exits.includes(id));
  document.body.classList.toggle("is-ended", !!more.dead);
  focusTitle(title);
}

function dead(/** @type {keyof typeof AUTH.dead} */ key) {
  const { title: heading, line, exit } = AUTH.dead[key];
  state(heading, line, {}, exit ? [exit === "signin" ? "to-signin" : exit] : [], { dead: true });
}

/** Any refusal that is not a code's: a dead invite, a rate limit, offline, or bloop down. */
function failed(/** @type {{error: string}} */ reply) {
  const e = reply.error;
  dead(
    e === "invite_dead"
      ? "invalid"
      : e === "rate_limited"
        ? "limited"
        : e === "offline" || e === "network_blocked"
          ? "offline"
          : "down",
  );
}

function open() {
  if (!invite) return;
  const at = expiryOf(invite.expiresAt);
  const until = at === null ? "" : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  state(AUTH.invite.title, AUTH.invite.to, { masked: invite.emailMasked }, ["accept"], { about: true, until });
}

/** Accept (and Send a New Code): a code goes to the invite's own address only (INV-02). */
async function send() {
  const reply = await api.post("/api/invite/accept", { token });
  if (reply.ok) challengeId = reply.value.challengeId;
  return reply;
}

const code = createCodeEntry(
  {
    input: /** @type {HTMLInputElement} */ (byId("code")),
    row,
    resend: /** @type {HTMLButtonElement} */ (byId("resend")),
    doc: document,
  },
  {
    verify: (digits) => api.post("/api/invite/verify", { challengeId, code: digits }),
    resend: send,
    done: () =>
      land(
        () => api.get("/api/me"),
        "/library",
        row,
        (path) => location.assign(path),
      ),
    refused: (reply) => {
      if (reply.error !== "invite_dead") return false;
      code.stop();
      dead("invalid");
      return true;
    },
  },
);

async function accept() {
  const button = /** @type {HTMLButtonElement} */ (byId("accept"));
  button.disabled = true;
  const reply = await send();
  button.disabled = false;
  if (!reply.ok) return failed(reply);
  // One history entry: Back on the code step returns to the invite.
  history.pushState({ step: "code" }, "");
  state(AUTH.code.title, AUTH.code.sentTo, { masked: reply.value.emailMasked ?? "" }, ["resend"], { code: true });
  code.start(expiryOf(reply.value.expiresAt));
}

async function peek() {
  if (!token) return dead("none");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return dead("invalid");
  const [answer, me] = await Promise.all([api.post("/api/invite/peek", { token }), api.get("/api/me")]);
  if (!answer.ok) return failed(answer);
  const { state: s, emailMasked, expiresAt } = answer.value;
  if (s !== "open") return dead(s === "used" || s === "expired" ? s : "invalid");
  invite = { emailMasked, expiresAt };
  // The local mock account has no email: it counts as signed out here.
  const email = me.ok && me.value.signedIn === true ? me.value.email : null;
  if (typeof email !== "string" || !email.includes("@")) return open();
  if (masked(email) === emailMasked) return location.replace("/library");
  state(AUTH.invite.signedInAs.replace("{masked}", masked(email)), AUTH.invite.forOther, { masked: emailMasked }, [
    "to-library",
    "sign-out",
  ]);
}

byId("accept").addEventListener("click", accept);
byId("sign-out").addEventListener("click", async () => {
  const reply = await api.post("/api/me/signout", {});
  if (reply.ok) accept();
  else failed(reply);
});
byId("retry").addEventListener("click", peek);
byId("terms").addEventListener("click", () => store.set(KEPT, token));
addEventListener("popstate", () => {
  if (history.state?.step === "code") history.replaceState(null, "");
  code.stop();
  open();
});
byId("back").addEventListener("click", (e) => {
  if (codeForm.hidden) return;
  e.preventDefault();
  history.back();
});

if (history.state?.step === "code") history.replaceState(null, "");
peek();
