# ADR 0014: invite-only sign-in

Status: proposed. Fable reviews it before any code is written against it. Data model: ADR 0013. Mode gate: ADR 0026. The Entra path (ADR 0004) is unchanged and shares the session code.

## Context
- bloop v4 opens accounts by invite only. Product decision: invites are single-use, hashed, valid 7 days and bound to one email, and opening the link never uses one up. The user enters a 6-digit email code, then is offered a passkey; with no passkey support the offer is hidden, and the email code always works as fallback and recovery.
- Mail scanners open links (and some run their JavaScript), so a link must be harmless to open.
- A 6-digit code is 20 bits. Its safety is entirely in the attempt limits, the expiry and the per-email request limits.
- The session cookie exists (`src/worker/auth/cookies.ts`, `src/worker/auth/sessions.ts`): `__Host-bloop_sid`, an opaque 256-bit value stored as its SHA-256, 30 days idle and 90 absolute, rotated on sign-in.
- WebAuthn refuses an IP-address relying party, and today's Permissions-Policy blocks `publickey-credentials-get` on every page.

## Decision

### Invites
- **Token:** 32 random bytes, base64url (43 characters). The link is `https://<host>/invite#t=<token>`: a fragment never reaches a server, a Referer or a log. The page reads it, then removes it with `history.replaceState`. The invite page sends `Referrer-Policy: no-referrer`. Only `SHA-256(token)` is stored (`invite.token_hash`); 256 bits of entropy need no pepper (INV-01).
- **States**, derived, never stored as one column: `open` (not accepted, not revoked, `expires_at` in the future), `accepted`, `revoked`, `expired`. Validity is checked at the moment of use, every time.
- **Opening never spends it (INV-03).** `POST /api/invite/peek {token}` reads only: it answers `{emailMasked, expiresAt, state}` and writes nothing. The page calls peek on load and shows Continue; nothing happens until a tap.
- **Continue sends a code to the bound email (INV-02).** `POST /api/invite/accept {token}` checks the invite is open and mails a code with purpose `invite` to the invite's own address. The user cannot type another address. Accept spends nothing either. It is capped at 5 codes per invite per day beside the per-email limits, so a scanner that clicks cannot flood the inbox.
- **The code spends it.** A correct `invite` code, verified while the invite is still open, creates the user and accepts the invite in one D1 batch: insert `app_user` by `INSERT ... SELECT ... FROM invite WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, then mark the invite accepted with the same guard, then create the session. Zero rows from the insert means the invite died in between (`invite_dead`); the unique `email_norm` index stops a second account for the same address.
- **Single use (INV-04):** an accepted, revoked or expired invite is refused at peek (state only), accept and verify.
- **Resend (INV-05)** replaces `token_hash` and resets `expires_at` to 7 days from now on the same row, so the old link dies at once. Creating an invite for an email that already has an open row is a resend of that row (ADR 0013, flag 2). Revoke sets `revoked_at`; the open invite codes die with it because verify re-checks the invite.
- **Invite for a member:** refused at create (`already_member`), so an invite never shadows an existing account.
- **Bootstrap:** the first admin's invite is written by the invite tool (tools/invite.mjs, owner A) through `wrangler d1 execute` (owner-run), since no admin exists to create one.

### Email codes
- **Code:** 6 decimal digits by rejection sampling over `crypto.getRandomValues` (no modulo bias). Expiry 10 minutes (`EMAIL_CODE_TTL_SECONDS`). The code is the first line of the body and never in the subject, so a lock-screen preview of the subject never shows it.
- **Storage (AUTH-09 mac):** `code_mac = HMAC-SHA256(CODE_PEPPER, id | purpose | email_norm | code)`. Binding the challenge id, purpose and address means a MAC cannot be moved to another challenge, and a D1 leak without the pepper gives nothing to brute force offline. The pepper is a Worker secret, 32 random bytes.
- **Verify, race-free (AUTH-09 attempts):**
  1. `UPDATE email_code SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < 5 RETURNING ...`. Zero rows: `code_invalid`, with nothing more said.
  2. Compare the MAC in constant time.
  3. On a match: `UPDATE email_code SET used_at = ? WHERE id = ? AND used_at IS NULL`, and go on only if it changed one row.
  Every verify, right or wrong, spends one of the 5 attempts before the compare, so parallel guesses cannot share an attempt.
- **Requests supersede:** a new code for the same email and purpose expires every open one (`idx_email_code_email`). With 10 codes a day per email and 5 attempts each, an attacker gets at most 50 guesses a day against one address, about 1 in 20,000.
- **Request limits:** Turnstile (ADR 0022), `RL_CODE` per IP, then exactly 3 per email per 15 minutes and 10 per day, counted from `email_code` rows.
- **No enumeration (AUTH-10 uniform):** `POST /api/auth/code/request` always answers 202 `{challengeId}` and always writes a row. For an address that is not an active (or `deleting`) member, or that the mode gate refuses, the row holds a MAC of a code nobody was sent, and no mail goes out. Mail is sent from `ctx.waitUntil`, so the response time does not depend on it. The per-email limits apply to unknown addresses too, so they reveal nothing.
- **Who receives a sign-in code:** `status` `active` or `deleting` (so a user in the deletion grace can sign in to restore). `suspended` gets nothing.
- **Recovery:** the email code is always available, so losing every passkey never locks an account. A compromised mailbox is a full account compromise; that is stated plainly (AUTH-17, residual).

### Passkeys
- **Library:** @simplewebauthn/server at 14.0.2 or later (its ADR 0001 line is F's). The browser side is the platform API only, in a lazy core webauthn module.
- **Relying party:** `rpID` is the hostname of `PUBLIC_ORIGIN`; the expected origin is exactly `PUBLIC_ORIGIN`. Local and e2e runs use `http://localhost`, never `127.0.0.1` (WebAuthn refuses IP addresses) (AUTH-12 origin).
- **Options:** discoverable credential (`residentKey: required`), `userVerification: required`, `attestation: none`. Sign-in sends no `allowCredentials` (usernameless); reauth lists the user's own credentials.
- **Ceremony (AUTH-12 challenge):** 32 random challenge bytes in `auth_challenge` with its purpose, user (for register and reauth) and `binder_hash`. The binder is a random value set in `__Host-bloop_wa` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 300). Verify deletes the challenge row with `DELETE ... RETURNING` (single use), requires the binder cookie to hash to it, and requires the row to be unexpired. A challenge minted in one browser cannot finish in another.
- **Counter:** if the stored `sign_count` and the new one are both non-zero and the new one is not larger, refuse and log a clone signal. Synced passkeys report 0 and pass.
- **The offer is feature-detected.** After a code sign-in the page shows "Add a Passkey" only when `PublicKeyCredential` exists and `isUserVerifyingPlatformAuthenticatorAvailable()` resolves true. When `PublicKeyCredential.getClientCapabilities()` reports `conditionalCreate`, the page instead registers with `mediation: "conditional"`, which the browser may finish without a prompt. Any failure or refusal hides the offer for the session and leaves the code path untouched. The sign-in page offers passkey sign-in only when `isConditionalMediationAvailable()` or the platform check passes, and always shows the email field.
- **Adding a passkey is C+R (AUTH-11 reauth):** a code sign-in counts as a fresh proof, so the offer right after sign-in passes. Every added passkey mails a "Passkey added" notice to the account address. Deleting one is C+R too.

### Session cookie
- **Attributes (unchanged, pinned):** `__Host-bloop_sid`, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, Max-Age 90 days; only its SHA-256 is stored; 30 days idle, 90 absolute. Lax, not Strict: a signed-in user who follows an emailed link to bloop arrives signed in. Every write is still guarded by Origin and `Sec-Fetch-Site` (AUTH-15 csrf).
- **The file origin never sees it.** The workers.dev host is a different registrable site (workers.dev is on the public suffix list), so the browser never sends a bloop cookie there, and the file-origin handlers never read one.
- **Rotation (AUTH-08 rotate):** every successful authentication (email code, passkey, reauth, admin sign-in link) issues a new value and deletes the presented one. A value set before sign-in can therefore never become a signed-in session.
- **Stored per session:** `method` (`code`, `passkey`, `link`, `entra`), a coarse `label` from the User-Agent class (never the raw string), `reauth_at`.
- **Sign-in hint:** a second cookie, `__Host-bloop_in=1`, readable by page script, carries no secret and only lets the landing page show Library instead of Sign In. The server never reads it. It is set and cleared beside the session cookie.
- **Revocation (AUTH-13 signout-all):** sign out deletes this session. Sign out everywhere deletes every session of the user and ends their live screens (ADR 0015). Suspension does both and refuses new sign-ins. An email change ends every other session.

### Reauth
- **C+R** is a valid session whose own `reauth_at` is within `REAUTH_SECONDS` (300). Sign-in sets it. A later proof is a passkey assertion with purpose `reauth`, or an email code with purpose `reauth` (`POST /api/me/reauth/code`). Either rotates the session and stamps the new row.
- **Needs C+R:** add or delete a passkey, change email, delete the account, export, and the admin mode switch (ADR 0026).
- **Email change (AUTH-14 change):** C+R, then a code to the new address (purpose `email_change`, `new_email_norm`), a notice to the old one, and on verify the address moves, every other session ends, and `email_norm` uniqueness is enforced by the index.

### Admin
- **Role from the secret (AUTH-16 admin):** a request is admin when its session user's `email_norm` is in `ADMIN_EMAILS` (normalized at config parse), checked on every request. No role column exists, so D1 write access alone cannot make an admin.
- **Admin sign-in link** (`POST /api/admin/users/:id/signin-link`) is the fallback for a user whose mail filter eats codes: a 256-bit token, stored as an `email_code` row with purpose `link` (its MAC over the token), single use, 15 minutes, shown once to the admin. It is refused for an admin's own account and for any `ADMIN_EMAILS` user, the resulting session has no `reauth_at` (so it cannot add a passkey or change the email without a fresh proof), the user gets a notice email, and the issue is logged to `admin_action`.

## Rejected
- **Magic links instead of codes:** mail scanners follow links, which would sign them in or spend the link, and a link signs in whichever device opens it, not the one waiting.
- **Invite token in the query string:** it would reach logs and Referer headers.
- **Consuming the invite on open:** scanners would spend it (INV-03).
- **Plain SHA-256 of the code:** 10^6 values; a D1 leak would reverse every live code at once.
- **Reusing `HASH_PEPPER` for code MACs:** rotating it after a code leak would also break every stored IP and session hash; one key per purpose.
- **Passkey only:** no recovery when a device is lost; the code is the recovery.
- **A role column for admins:** a D1 write would grant admin.
- **SameSite=Strict session:** every arrival from mail would look signed out.
- **TOTP or SMS:** a new dependency or a new vendor, against product decision 9.

## Consequences
- Sign-in is two taps and one code for everyone; a passkey makes later sign-ins one tap.
- The email account is the root of trust (AUTH-17). Passkeys raise the bar for sign-in but not for recovery.
- A third party can make someone's sign-in mail arrive up to 10 times a day (the per-email cap), and then lock out their code path for the rest of the day. A passkey user is unaffected. Stated as residual on AUTH-09.
- Turnstile is needed on the code request; a Turnstile outage blocks code sign-in but not passkey sign-in.
- New secret: `CODE_PEPPER`. Rotating it kills every open code and admin link, nothing else.

## Threats served
AUTH-08 to AUTH-17, INV-01 to INV-05, MODE-01 (the mode gate at code request, accept and verify, ADR 0026).

## How to remove it
Close invites (refuse `/api/invite/accept`), keep code sign-in for existing users, or turn accounts off entirely as ADR 0013 describes. Passkeys alone come out by deleting the passkey routes, the lazy module and the `passkey` and `auth_challenge` tables one deploy later, and the email code remains the only method.

## Flags (Part 2 unsafe, ambiguous or contradicting Part 1, and the resolution)
1. **Race in Part 2's "5 attempts":** read-then-compare lets parallel guesses share an attempt. Resolved: the increment is the guard and comes first.
2. **Attempt multiplication:** Part 2 never said a new code supersedes the old one, so each request would add 5 fresh guesses. Resolved: supersede per email and purpose.
3. **Enumeration through the per-email limit and through mail timing:** resolved by writing a row for every address and sending from `waitUntil`.
4. **Bootstrap contradiction with Part 1 ("invites only to TEST_EMAILS" in preview):** an admin must exist to invite anyone. Resolved: the invite tool (tools/invite.mjs, owner A) writes the admin's invite directly; the route-level rule (route invites only to `TEST_EMAILS` in preview) stands, and accept and verify in preview admit `ADMIN_EMAILS` plus `TEST_EMAILS`.
5. **The admin sign-in link** in Part 2 is an admin-issued credential with no limits stated. Resolved with the limits above; the reviewer may cut it entirely (the code is the recovery).
6. **Part 2's C label** says "user status active" but the deletion grace needs a signed-in `deleting` user to restore. Resolved: `deleting` reaches `/api/me` and restore only.
7. **Reauth rotation** was unstated. Resolved: every fresh proof rotates.
8. **Sign out everywhere** did not say whether live screens end. Resolved: they do (a lost phone should also cut the screen).
