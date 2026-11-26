# ADR 0014: invite-only sign-in

Status: proposed. Data model: ADR 0013. Mode gate: ADR 0026. The Entra path (ADR 0004) is unchanged and shares the session code.

## Context
- bloop v4 opens accounts by invite only. Product decision: invites are single-use, hashed, valid 7 days and bound to one email, and opening the link never uses one up. The user enters a 6-digit email code, then is offered a passkey; with no passkey support the offer is hidden, and the email code always works as fallback and recovery.
- Mail scanners open links (and some run their JavaScript), so a link must be harmless to open.
- A 6-digit code is 20 bits. Its safety is entirely in the attempt limits, the expiry and the request limits, and those limits must not become a way for a stranger to lock a member out.
- The session cookie exists (`src/worker/auth/cookies.ts`, `src/worker/auth/sessions.ts`): `__Host-bloop_sid`, an opaque 256-bit value stored as its SHA-256, 30 days idle and 90 absolute, rotated on sign-in.
- WebAuthn refuses an IP-address relying party, and today's Permissions-Policy blocks `publickey-credentials-get` on every page.
- Cloudflare's invocation logs keep full request URLs for days, possibly outside the EU; they are turned off (`invocation_logs: false`, F), so no token in a path reaches them.

## Decision

### Two sign-in methods, no third
Email code and passkey. Nothing else creates a session for an email user: no magic link, no admin-issued link. An address that cannot receive codes cannot receive an invite either, so a link fallback would serve no one the invite flow admits.

### Invites
- **Token:** 32 random bytes, base64url (43 characters). The link is `https://<host>/invite#t=<token>`: a fragment never reaches a server, a Referer or a log. The page reads it, then removes it with `history.replaceState`. The invite page sends `Referrer-Policy: no-referrer`. Only `SHA-256(token)` is stored; 256 bits of entropy need no pepper (INV-01).
- **States**, derived, never stored as one column: `open` (not accepted, not revoked, `expires_at` in the future), `accepted`, `revoked`, `expired`. Validity is checked at the moment of use, every time.
- **Opening never spends it (INV-03).** `POST /api/invite/peek {token}` reads only: it answers `{emailMasked, expiresAt, state}` and writes nothing. Nothing happens until a tap.
- **Continue sends a code to the bound email (INV-02).** `POST /api/invite/accept {token}` checks the invite is open and mails a code with purpose `invite` to the invite's own address. The user cannot type another address. Accept spends nothing. Codes for an invite are limited per invite only (5 a day), never by the address, so no request elsewhere can block an invitee.
- **The acceptance page** says "By continuing you confirm you are 18 or over and accept the Terms", and verify writes `terms_version` and `terms_accepted_at` (ADR 0013).
- **The code spends it.** A correct `invite` code, verified while the invite is still open, creates the user and accepts the invite in one D1 batch: insert `app_user` by `INSERT ... SELECT ... FROM invite WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, mark the invite accepted with the same guard, create the session. Zero rows from the insert means the invite died in between (`invite_dead`); the unique `email_norm` index stops a second account for the same address.
- **Single use (INV-04):** an accepted, revoked or expired invite is refused at peek (state only), accept and verify.
- **Create and resend (INV-05):** create is `INSERT ... ON CONFLICT (email_norm) WHERE accepted_at IS NULL AND revoked_at IS NULL DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, sends = invite.sends + 1`, so an email with an open row (expired or not) gets that row reissued, and the old link dies at once. Resend is the same reissue. Revoke sets `revoked_at`; open invite codes die with it because verify re-checks the invite.
- **Invite for a member:** refused at create (`already_member`).
- **Bootstrap:** the first admin's invite is written by the owner's invite tool (tools/invite.mjs, owner A) through `wrangler d1 execute`, since no admin exists to create one.

### Email codes
- **Code:** 6 decimal digits by rejection sampling over `crypto.getRandomValues` (no modulo bias). Expiry 10 minutes (`EMAIL_CODE_TTL_SECONDS`).
- **The email:** the first line is a preheader, "Your bloop code is inside. Enter it only at bloop.here.", and the code is on line two. Lock-screen previews show the subject and the first body line, so neither carries the code.
- **Storage (AUTH-09 mac):** `code_mac = HMAC-SHA256(CODE_PEPPER, id | purpose | email_norm | new_email_norm | code)`, with `new_email_norm` empty when absent. Binding the challenge id, purpose and both addresses means a MAC cannot be moved to another challenge or another target address, and a D1 leak without the pepper gives nothing to brute force offline.
- **Verify is bound to its endpoint (AUTH-09 attempts):**
  1. `UPDATE email_code SET attempts = attempts + 1 WHERE id = ? AND purpose = :expected AND used_at IS NULL AND expires_at > ? AND attempts < 5 RETURNING ...`, plus `AND user_id = :sessionUser` for `reauth` and `email_change`. Zero rows: `code_invalid`, with nothing more said. So an `email_change`, `reauth` or `invite` challenge id is never accepted by sign-in verify, nor the other way round.
  2. Compare the MAC in constant time.
  3. On a match: `UPDATE email_code SET used_at = ? WHERE id = ? AND used_at IS NULL`, and go on only if it changed one row. For `invite`, the batch above re-checks the invite.
  Every verify, right or wrong, spends one of the 5 attempts before the compare, so parallel guesses cannot share an attempt.
- **Limits and supersede are per bucket, so strangers cannot reach a member's bucket:**
  - `signin`: per `(email_norm, purpose, known)`. `known = 1` when the request carries `__Host-bloop_dev` whose HMAC verifies for the member that address names (the known-device cookie below). The cookie is set at every successful verify (HttpOnly, Secure, SameSite=Lax, Path=/, the longest Max-Age the browser keeps). A stranger has no such cookie, so their requests (3 per 15 minutes, 10 a day) and the codes they trigger supersede only the `known = 0` bucket, and a member on a device they have signed in from before is never blocked or superseded by them.
  - `invite`: per invite (above). `reauth` and `email_change`: per `(user_id, purpose)`; only the signed-in member can request them.
  - A new code supersedes the open ones in its own bucket only. At 10 codes a day and 5 attempts each, one bucket allows 50 guesses a day, about 1 in 20,000.
  - Residual: a member's first sign-in on a new device can be delayed by a stranger filling the `known = 0` bucket for their address. Passkey sign-in is unaffected.
- **Other request limits:** Turnstile (ADR 0022) and `RL_CODE` per IP before any bucket is counted.
- **No enumeration (AUTH-10 uniform):** `POST /api/auth/code/request` always answers 202 `{challengeId}` and always writes a row. For an address that is not an active (or `deleting`) member, or that the mode gate refuses, the row holds a MAC of a code nobody was sent, and no mail goes out. Mail is sent from `ctx.waitUntil`, so the response time does not depend on it. The buckets apply to unknown addresses too, and an unknown address can never be `known`, so they reveal nothing.
- **Who receives a sign-in code:** `status` `active` or `deleting` (so a user in the deletion grace can sign in to restore), and `suspended_at IS NULL`. `purging` and suspended members get nothing.
- **Recovery:** the email code is always available, so losing every passkey never locks an account. A compromised mailbox is a full account compromise; that is stated plainly (AUTH-17, residual).

### Passkeys
- **Library:** @simplewebauthn/server at 14.0.2 or later (its ADR 0001 line is F's). The browser side is the platform API only, in a lazy core webauthn module.
- **Relying party:** `rpID` is the hostname of `PUBLIC_ORIGIN`; the expected origin is exactly `PUBLIC_ORIGIN`. Local and e2e runs use `http://localhost`, never `127.0.0.1` (WebAuthn refuses IP addresses) (AUTH-12 origin). Every auth and WebAuthn route answers 404 on the workers.dev file host, which serves no `/.well-known/webauthn`.
- **Registration:** `user.id` is the bytes of `app_user.id`; discoverable credential (`residentKey: required`), `userVerification: required`, `attestation: none`, and `excludeCredentials` lists the user's existing passkeys so one authenticator is not registered twice.
- **Sign-in:** no `allowCredentials` (usernameless). Verify looks the credential up by id and requires the response's `userHandle` to equal that row's `user_id`. Reauth lists the user's own credentials and requires the credential to belong to the session user.
- **Ceremony (AUTH-12 challenge):** 32 random challenge bytes in `auth_challenge` with its purpose, user (for register and reauth) and `binder_hash`. The binder is a random value set in `__Host-bloop_bind` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 600). Verify deletes the challenge row with `DELETE ... RETURNING` (single use) and requires: the row unexpired (5 minutes), its purpose equal to the endpoint's, its user equal to the session user for register and reauth, and the binder cookie hashing to it. A challenge minted in one browser or for one purpose cannot finish in another.
- **Counter:** `UPDATE passkey SET sign_count = :n, last_used_at = :now WHERE id = ? AND (sign_count = 0 OR sign_count < :n)`. When the stored count is non-zero and the update changes nothing, the assertion is refused and a clone signal is logged. Synced passkeys report 0 and pass.
- **The offer is an explicit button, feature-detected.** After a code sign-in the page shows "Add a Passkey" only when `PublicKeyCredential` exists and `isUserVerifyingPlatformAuthenticatorAvailable()` resolves true. It never registers silently (no conditional create). Any failure or refusal hides the offer for the session and leaves the code path untouched. The sign-in page offers passkey sign-in only when `isConditionalMediationAvailable()` or the platform check passes, and always shows the email field.
- **Adding a passkey is C+R (AUTH-11 reauth):** a code sign-in counts as a fresh proof, so the offer right after sign-in passes. Every added passkey mails a "Passkey added" notice. Deleting one is C+R too.

### Session cookie
- **Attributes (unchanged, pinned):** `__Host-bloop_sid`, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, Max-Age 90 days; only its SHA-256 is stored; 30 days idle, 90 absolute. Lax, not Strict: a signed-in user who follows an emailed link to bloop arrives signed in. Every write is still guarded by Origin and `Sec-Fetch-Site` (AUTH-15 csrf).
- **The file origin never sees it.** The workers.dev host is a different registrable site (workers.dev is on the public suffix list), so the browser never sends a bloop cookie there, and the file-origin handlers never read one.
- **Rotation (AUTH-08 rotate):** every successful authentication (email code, passkey, reauth) issues a new value and a new `public_id`, and deletes the presented session. A value set before sign-in can therefore never become a signed-in session.
- **Stored per session:** `public_id` (the only id shown or sent anywhere), `method` (`code`, `passkey`, `entra`), a coarse `label` from the User-Agent class (never the raw string), `reauth_at`.
- **Sign-in hint:** `__Host-bloop_in=1`, HttpOnly like every cookie (the one format in `src/worker/auth/cookies.ts`), carries no secret and only selects a label: the Worker swaps the open pages' pill from Sign In to Library while serving them (`src/worker/nav-pill.ts`), with `Vary: Cookie` and its own ETag, and page script never reads it. It is set and cleared beside the session cookie.
- **Revocation (AUTH-13 signout-all):**
  - Sign out deletes this session and ends the live screens this session started (ADR 0015).
  - Sign out everywhere deletes every session of the user and ends all their live screens.
  - Suspension does both and refuses new sign-ins.
  - A deletion request ends all live screens and deletes every other session; the current one stays, limited to `/api/me` and restore.
  - An email change ends every other session.

### Reauth
- **C+R** is a valid session whose own `reauth_at` is within `REAUTH_SECONDS` (300). Sign-in sets it. A later proof is a passkey assertion with purpose `reauth`, or an email code with purpose `reauth` (`POST /api/me/reauth/code`). Either rotates the session and stamps the new row.
- **Admin writes** additionally need a passkey registered at least 24 hours earlier, so a fresh account takeover cannot reach them.
- **Known-device cookie:** `nonce.HMAC(CODE_PEPPER, "dev|" + uid + "|" + epoch + "|" + nonce)` (the epoch: below); sign out everywhere clears it.
- **Needs C+R:** add or delete a passkey, change email, delete the account, export, and the admin mode switch (ADR 0026).
- **Email change (AUTH-14 change):** C+R, then a code to the new address (purpose `email_change`, `new_email_norm` in the MAC). On verify, `UPDATE app_user SET email_norm = :new, email = :newDisplay WHERE id = :u AND email_norm = :old` (so a second change in flight cannot stack), every other session ends, and the unique index refuses an address already in use.
- **Revert:** the old address gets a notice with a 7-day revert link carrying a 256-bit token (an `email_code` row with purpose `email_revert`, `email_norm` the old address, `new_email_norm` the new one, its MAC over the token). Opening the page shows a button; the tap moves the address back with `WHERE id = :u AND email_norm = :new`, ends every session, and mails the old address. So a hijacked session that changes the email can be undone by the mailbox owner.

### Admin
- **Role from the secret (AUTH-16 admin):** a request is admin when its session user's `email_norm` is in `ADMIN_EMAILS` (normalized at config parse), checked on every request. No role column exists, so D1 write access alone cannot make an admin. Admin has no route that signs in as, or reads the library of, another member.

### Mode gate
State-creating steps (invite create, accept, code verify, passkey session creation) read `launch_mode` and `preview_lockout` uncached, so the 30 s cache (ADR 0026) never lets one through after a switch back to preview. In preview, existing members sign in as usual unless `preview_lockout` is set; invites stay limited as ADR 0026 says.

### Amendments
- **Reauth keeps `public_id`:** a reauth rotates the cookie value and deletes the presented row, but carries `public_id` over, because a live screen is keyed to the claiming session's `public_id` (ADR 0015) and a reauth changes no privilege. Every sign-in still mints a new one. The delete and the insert are one batch.
- **The hint cookie is HttpOnly:** `__Host-bloop_in` has the session cookie's attributes and only the server reads it; no page script reads any bloop cookie. It still grants nothing.
- **Sign-out and the device cookie:** a plain sign-out clears the session and hint cookies and keeps `__Host-bloop_dev`, so the device stays known; sign out everywhere clears all three. Any live session may sign itself out, including a deleting or locked-out member's and an Entra user's.
- **The device value carries an epoch:** the known-device MAC is `HMAC(CODE_PEPPER, "dev|" + uid + "|" + epoch + "|" + nonce)`. Sign out everywhere, a passkey or email change and a deletion request bump the member's epoch, so every device value issued before is refused on every device, not only the one that cleared its cookie. The epoch is `app_user.device_epoch` (migration 0006), moved in one batch with the change: sign out everywhere, ending one session from the devices list, a passkey removal and a deletion request today, passkey registration and an email change when their routes land.
- **Admin routes answer before the write checks:** an admin route resolves the member and the admin role before the Origin, fetch-metadata and content-type checks and before any body is read, so a non-admin gets the same `not_found` for a foreign Origin, a non-JSON body or a wrong method (the router answers 404, never 405 or `Allow`, under `/api/admin/`) as for an unknown path.
- **Rate limits on member routes:** every member and admin route, read or write, spends the coarse IP-keyed `RL_MEMBER_IP` (300 per 60 s) before any D1 read: a flood guard sized for a shared campus NAT, so unmetered D1 reads are impossible; the per-member `RL_MEMBER` at 120 stays the real limiter; then reads and writes spend the member-keyed `RL_MEMBER` (120 per 60 s) after the session read, and `GET /api/me` spends it once it has a live session. An admin route answers a refused `RL_MEMBER_IP` with `not_found` and checks nothing else before the admin check, so a non-admin's answer is the unknown path's at every request count; after it, `RL_ADMIN` per admin.
- **One display-name rule:** `auth/names.ts` owns what a name a member types may hold (letters, marks, digits, space, hyphen, apostrophe, whole emoji; ZWJ only inside an emoji, ZWNJ only between letters; no other format character; no Hangul filler and no letter that passes for `.`, `:` or `/`; 1 to 40 code points after NFC). Passkey names use it; the library's names will.
- **An invalid config answers 500 on admin routes too:** like every route behind the config, an admin path answers `internal` while the config is invalid, where an unknown path answers 404; only a broken deploy shows it, and that deploy already raises the config_invalid alert.
- **`DELETE /api/me` spends only the IP limit:** an email member's deletion request needs a fresh proof, which already bounds it per member, so it spends `RL_MEMBER_IP` and no member-keyed limit.
- **A dead session signs out too:** sign-out with a missing or dead session answers `auth_required` and still clears the session and hint cookies. A read never clears a cookie: `GET /api/me` with a cookie naming no live session answers signed out and sets nothing, so a slow read that lands after a sign-in rotated the cookie cannot clear the new one.
- **The MAC input is length-prefixed:** each field of the `code_mac` input above is written `len:value` before the `|` join (`auth/codes.ts` `codeMac`), so no two field splits, even ones containing `|`, give the same input.

## Rejected
- **Magic links instead of codes:** mail scanners follow links, which would sign them in or spend the link, and a link signs in whichever device opens it, not the one waiting.
- **An admin-issued sign-in link:** a third method outside the owner's decision, the magic link rejected above, and a hijacked admin session could read any member's library.
- **Conditional create (silent passkey registration):** not the "offer" decided, and platforms allow it only after a password autofill, which bloop never has.
- **Invite token in the query string:** it would reach logs and Referer headers.
- **Consuming the invite on open:** scanners would spend it (INV-03).
- **Plain SHA-256 of the code:** 10^6 values; a D1 leak would reverse every live code at once.
- **Reusing `HASH_PEPPER` for code MACs:** rotating it after a code leak would also break every stored IP and session hash; one key per purpose.
- **One per-email limit for everyone:** a stranger's requests would supersede a member's live code and block sign-in indefinitely.
- **Passkey only:** no recovery when a device is lost; the code is the recovery.
- **A role column for admins:** a D1 write would grant admin.
- **SameSite=Strict session:** every arrival from mail would look signed out.
- **TOTP or SMS:** a new dependency or a new vendor, against product decision 9.

## Consequences
- Sign-in is two taps and one code for everyone; a passkey makes later sign-ins one tap.
- The email account is the root of trust (AUTH-17). Passkeys raise the bar for sign-in but not for recovery; the revert link limits what a hijacked session can do to the address.
- Turnstile is needed on the code request; a Turnstile outage blocks code sign-in but not passkey sign-in.
- New secret: `CODE_PEPPER`. Rotating it kills every open code and revert link and resets every known-device cookie to unknown, nothing else.

## Threats served
AUTH-08 to AUTH-17, INV-01 to INV-05, MODE-01 (the mode gate at code request, accept and verify, ADR 0026).

## How to remove it
Close invites (refuse `/api/invite/accept`), keep code sign-in for existing users, or turn accounts off entirely as ADR 0013 describes. Passkeys alone come out by deleting the passkey routes, the lazy module and the `passkey` and `auth_challenge` tables one deploy later, and the email code remains the only method.
