// /invite#t=<token>: peek, then Accept, then the code step, then the library (docs/ux/signin.md section 5). The token
// lives only in the fragment, which never reaches a server; the page drops it from the address before any request.
import { AUTH, fill } from "./auth/copy.js";
import { INVITE } from "./auth/copy-invite.js";
import { createRow, quietSkip, watch } from "./auth/row.js";
import { createApi } from "./core/api.js";
import { byId, focusTitle, setText, show } from "./core/ui.js";

/** Holds the token while Terms is open in this tab, so Back resumes the invite; gone on the next show of the page. */
const KEPT = "bloop.invite";
/** This tab's sessionStorage, or nothing when the browser blocks it (the invite then needs its link again). */
const kept = (/** @type {(area: Storage) => string | null | void} */ use) => {
  try {
    return use(sessionStorage) ?? null;
  } catch {
    return null;
  }
};
const forget = () => kept((area) => area.removeItem(KEPT));

const api = createApi({ appCodes: true });
const title = byId("title");
const codeForm = byId("code-form");
const accepting = /** @type {HTMLButtonElement} */ (byId("accept"));
const row = createRow({
  hint: byId("code-hint"),
  hintText: byId("code-hint-text"),
  error: byId("code-error"),
  errorText: byId("code-error-text"),
});

const hash = location.hash;
if (hash) history.replaceState(null, "", location.pathname);
const token = hash ? (/^#t=(.*)$/.exec(hash)?.[1] ?? "") : (kept((area) => area.getItem(KEPT)) ?? "");
forget();

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
  if (more.until) fill(byId("until"), INVITE.until, { date: more.until });
  show(codeForm, !!more.code);
  show(byId("exits"), exits.length > 0);
  show(byId("adult"), exits.includes("accept"));
  for (const id of ["to-library", "accept", "sign-out", "home", "to-signin", "retry", "resend"])
    show(byId(id), exits.includes(id));
  document.body.classList.toggle("is-ended", !!more.dead);
  focusTitle(title);
}

function dead(/** @type {keyof typeof INVITE.dead} */ key) {
  const { title: heading, line, exit } = INVITE.dead[key];
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
  const at = invite.expiresAt;
  // The invite's date is the server's, shown as a date only: no deadline on this page reads the device clock.
  const until =
    typeof at === "number" ? new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  state(INVITE.title, INVITE.to, { masked: invite.emailMasked }, ["accept"], { about: true, until });
  // The code step loads while the invitee reads.
  code().catch(() => {});
}

/** Accept (and Send a New Code): a code goes to the invite's own address only (INV-02). */
async function send() {
  const reply = await api.post("/api/invite/accept", { token });
  if (reply.ok) challengeId = reply.value.challengeId;
  return reply;
}

/** The code step, loaded once the invite is open and bound once. */
/** @type {Promise<{start: (answer: unknown) => void, stop: () => void}> | undefined} */
let codeStep;
function code() {
  codeStep ??= import("./auth/code-entry.js")
    .then(({ createCodeEntry, land }) => {
      const entry = createCodeEntry(
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
            entry.stop();
            dead("invalid");
            return true;
          },
        },
      );
      return entry;
    })
    .catch((e) => {
      codeStep = undefined;
      throw e;
    });
  return codeStep;
}

/** The accept in flight: a second tap while it runs waits for it instead of mailing a second code. */
/** @type {ReturnType<typeof send> | null} */
let pending = null;

function idle(/** @type {boolean} */ on) {
  accepting.disabled = !on;
  /** @type {HTMLElement} */ (accepting.querySelector(".spinner")).hidden = on;
}

async function accept() {
  if (!pending) {
    pending = send();
    pending.finally(() => {
      pending = null;
    });
  }
  idle(false);
  // The slow rule's stop gives the button back; a code sent after it still opens the step.
  const reply = await watch(pending, { slow: () => {}, stop: () => idle(true) });
  idle(true);
  if (!reply.ok) return failed(reply);
  let step;
  try {
    step = await code();
  } catch {
    return failed({ error: "offline" });
  }
  forget();
  // One history entry: Back on the code step returns to the invite.
  history.pushState({ step: "code" }, "");
  state(AUTH.code.title, AUTH.code.sentTo, { masked: reply.value.emailMasked ?? "" }, ["resend"], { code: true });
  step.start(reply.value);
}

async function peek() {
  if (!token) return dead("none");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return dead("invalid");
  const [answer, me] = await Promise.all([api.post("/api/invite/peek", { token }), api.get("/api/me")]);
  if (!answer.ok) return failed(answer);
  const { state: s, emailMasked, expiresAt, forYou } = answer.value;
  if (s !== "open") return dead(s === "used" || s === "expired" ? s : "invalid");
  // The server compares the session's address with the invite's; the page never guesses from masks.
  if (forYou === true) return location.replace("/library");
  invite = { emailMasked, expiresAt };
  // The local mock account has no email: it counts as signed out here.
  const email = me.ok && me.value.signedIn === true ? me.value.email : null;
  if (typeof email !== "string" || !email.includes("@")) return open();
  state(INVITE.signedInAs.replace("{masked}", masked(email)), INVITE.forOther, { masked: emailMasked }, [
    "to-library",
    "sign-out",
  ]);
}

accepting.addEventListener("click", accept);
byId("sign-out").addEventListener("click", async () => {
  const reply = await api.post("/api/me/signout", {});
  // A session already gone is signed out too: the invite goes on.
  if (reply.ok || reply.error === "auth_required") accept();
  else failed(reply);
});
byId("retry").addEventListener("click", peek);
byId("terms").addEventListener("click", () => kept((area) => area.setItem(KEPT, token)));
// Back from Terms out of the back-forward cache runs no script: the token kept for it goes here instead.
addEventListener("pageshow", forget);
addEventListener("popstate", () => {
  if (history.state?.step === "code") history.replaceState(null, "");
  codeStep?.then((c) => c.stop()).catch(() => {});
  open();
});
byId("back").addEventListener("click", (e) => {
  if (codeForm.hidden) return;
  e.preventDefault();
  history.back();
});
quietSkip(document, () => focusTitle(title));

if (history.state?.step === "code") history.replaceState(null, "");
peek();
