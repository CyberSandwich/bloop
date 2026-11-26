# Sign-in and invite (`/signin`, `/invite`)

Invite-only accounts. An invite link proves the email; a 6-digit email code signs in; a passkey is offered after, and the email code always stays the fallback and recovery. Both pages are app pages on `/a`'s frame: the corner bar with Back, a 480 column, the bottom action panel under 640 (README.md, Shared rules). Server routes: plan A.4 (auth); emails: plan A.10.

## 1. `/signin`: email step

```
390 x 844                                        1440 (column centered in the viewport, max 480)

  <Back                                            <Back

  Sign In                                                      Sign In
  Early access is by invite. Use the                           Early access is by invite. Use the
  email your invite went to.                                   email your invite went to.

  Email                                                        Email
  +------------------------------------+                       +--------------------------------+
  | you@university.ac.uk               |                       |                                |
  +------------------------------------+                       +--------------------------------+
  [ Sign In with a Passkey ]                                   ( Sign In with a Passkey )
                                                               [[ Email Me a Code ]]
.--------------------------------------.
| [[        Email Me a Code         ]] |                       No invite? Join the waitlist.
'--------------------------------------'
  No invite? Join the waitlist.
```

- Title "Sign In" (the phone title, 28/600, centered as `/a`'s phone titles), line "Early access is by invite. Use the email your invite went to." (`--muted`).
- **Field:** the `/code` field's look (56 tall, `--r-field`, the `--g2` ring turning 2 px ink on focus), label "Email" visible above, 17 px (never under 16, so iOS never zooms), `type="email"`, `autocomplete="username webauthn"` (so a saved passkey is offered in the keyboard bar: conditional mediation), `autocapitalize="off"`, `spellcheck="false"`, `enterkeyhint="send"`.
- **Email Me a Code** (primary) is enabled once the field holds something shaped like an email; Enter submits.
- **Sign In with a Passkey** (secondary under 640, text button from 640 where the primary sits beside it) only where `PublicKeyCredential` exists; it opens the browser's passkey sheet (a modal get). Hidden when the browser has no passkey support (the plan's rule), so nobody taps a dead button.
- "No invite? Join the waitlist." (15 `--muted`, the link on "Join the waitlist", Tally, `source=signin`, `data-waitlist`), under the panel on a phone, under the buttons on a desktop.
- **Turnstile:** the managed widget in its invisible mode, loaded on the first keystroke or tap in the field (lazy; the page's own focus loads nothing), run on submit. Only when it needs a human does it show its own box, in the line's place under the field; the button reads "Checking..." meanwhile. If its script cannot load (a blocker): the line "Turn off content blocking for bloop.here to sign in." with Try Again; the code request needs it (plan A.9).
- **Focus order:** Back, the title (focused on load only when arriving from a redirect; otherwise the field, so a typed visit starts typing), Email, Sign In with a Passkey, Email Me a Code, the waitlist link.
- **Next.** `?next=` is one of `/library`, `/a`, `/account`, `/admin`; anything else is `/library`. Signed in already: the page redirects to `next` at once (server side), so Library is one tap from the landing for a signed-in user.

## 2. `/signin`: code step

The code request always answers the same, whether or not the email has an account (no enumeration, plan A.4), so the line says "if".

```
390                                              1440

  <Back                                            <Back

  Check Your Email                                         Check Your Email
  If you@university.ac.uk has early access,                If you@university.ac.uk has early
  a code is on its way.                                    access, a code is on its way.

  Code                                                     Code
  +------------------------------------+                   +--------------------------------+
  |   4 8 1   2 0 7                    |                   |  4 8 1   2 0 7                 |
  +------------------------------------+                   +--------------------------------+
  Enter the 6 digits from the email.                       Enter the 6 digits from the email.

  ( Use a Different Email )                                ( Use a Different Email )
                                                           ( Send a New Code in 0:24 )
.--------------------------------------.
| ( Send a New Code in 0:24 )          |
'--------------------------------------'
```

- Title "Check Your Email"; line "If you@university.ac.uk has early access, a code is on its way." (the address as typed, `--ink` 600).
- **Field:** label "Code", `inputmode="numeric"`, `autocomplete="one-time-code"` (iOS offers the code from Mail; Android from the notification), 6 digits shown in two groups of 3, as `/code` (22/600, tracked +0.06em). No button: the 6th digit submits. A paste of the whole code submits; more than 6 digits is not a code, and the field clears. The sentence row under the field (24 tall, kept while empty, as `/code`) holds "Enter the 6 digits from the email." and, on failure, the error.
- **Errors** (one line each at 390, `role="alert"`, the field keeps its digits selected so retyping replaces them):
  - wrong code: "That code didn't match. Try again."
  - expired (10 minutes): "That code has expired. Send a new one."
  - too many tries (the attempt cap): "Too many tries. Send a new code."
  - offline: "You're offline. Check your connection, then try again."
- **Send a New Code** (text button): disabled with its countdown "Send a New Code in 0:24" for 30 s after each send (tabular, so it never jitters), then "Send a New Code". Over the per-email limit: "Too many codes for now. Try again in 15 minutes." in the sentence row, the button disabled.
- **Use a Different Email** returns to the email step with the field filled and selected.
- **Leaving to read mail:** the tab keeps its state (nothing times out on the page); returning from the Mail app lands on the same field, focused.
- **Verifying:** the field disables and the sentence row reads "Checking..." with the spinner. Success goes to the passkey offer, or to `next` if this device already has a passkey for this account or the browser has no passkey support.

## 3. Passkey offer (after the first code sign-in on a device)

```
390                                              1440

  Sign In Faster Next Time                                 Sign In Faster Next Time
  Save a passkey on this phone. Your email                 Save a passkey on this device. Your
  code still works if you lose it.                         email code still works if you lose it.

  (key-round glyph, 28, on the glass tile)                 [ Not Now ]  [[ Save a Passkey ]]
.--------------------------------------.
| [[        Save a Passkey          ]] |
| [            Not Now             ]   |
'--------------------------------------'
```

- Title "Sign In Faster Next Time"; line "Save a passkey on this phone. Your email code still works if you lose it." ("this device" from 640 and on a desktop). The features band's glass tile with Lucide `key-round` above the title, as the empty library's.
- No Back: two exits are on the page. Save a Passkey opens the browser's create sheet (conditional create where supported, so a password manager can save it without a second prompt).
  - Saved: toast "Passkey Saved" / "Next time, choose it when you sign in." and go to `next`. A notice email goes out (plan A.10, Passkey added).
  - The browser's sheet canceled or failed: stay, with the line in the sentence row "The passkey wasn't saved. Try again, or continue without it." Never an error page.
- Not Now: go to `next`, and do not offer again on this device for 30 days (`localStorage`); Account always has Add a Passkey.
- Lazy: the webauthn module is already loaded where passkeys exist (section 1); the offer's markup is in the page.

## 4. Passkey sign-in

- From the keyboard bar (conditional mediation) or Sign In with a Passkey. On success the page goes to `next`; a toast is not needed (the next page is the proof).
- Canceled sheet: nothing changes, focus returns to the field.
- No matching passkey on this device (the browser offers another device's QR): left to the browser's own sheet.
- A passkey for an account that is suspended or deleting: the server refuses, and the page shows the email step with the line "This account can't sign in right now. Email hi@bloop.here." (`role="alert"`).

## 5. `/invite#t=...`

The link from the invite email. The token is in the fragment, so it never reaches a server log; the page reads it, calls `/api/invite/peek` (which never uses the invite up), and removes the fragment with `history.replaceState`.

```
390                                              1440

  You're Invited                                           You're Invited
  Early access to bloop for                                Early access to bloop for
  y**@university.ac.uk.                                    y**@university.ac.uk.

  bloop puts your files on the room                        bloop puts your files on the room
  screen from your phone. The screen never                 screen from your phone. The screen
  gets your account.                                       never gets your account.

  The invite works until 2 Dec.                            The invite works until 2 Dec.
.--------------------------------------.                   [[ Accept Invite ]]
| [[         Accept Invite          ]] |
'--------------------------------------'
```

- Title "You're Invited"; line "Early access to **bloop** for y**@university.ac.uk." (masked by the server); the footer's one sentence of what bloop is, restated as the landing's, so an invitee who never saw the site knows what they accept; "The invite works until 2 Dec." (`--muted`, the date from `expiresAt`, the user's locale, day and short month).
- Above Accept Invite: "By continuing you confirm you are 18 or over and accept the Terms." (13 `--muted`, in the panel). Terms opens `/terms` in place; the token waits in `sessionStorage` (`bloop.invite`) for this tab only, so Back resumes the invite.
- Accept Invite sends the code to the invited address and goes to the code step (section 2), with the line "A code is on its way to y**@university.ac.uk." (no "if": the address is known). Verifying the code creates the account and consumes the invite in one step; then the passkey offer; then `next` is `/library`, whose empty state starts the user off (library.md section 8).
- **Peek states** (each laid out as a dead end, centered, one exit):

| State | Title | Line | Button |
|---|---|---|---|
| loading | skeleton title bar | (none) | none |
| expired | This Invite Has Expired | Ask the person who invited you for a new one. | Go to the Home Page |
| used | This Invite Was Already Used | Sign in with the email it went to. | Sign In |
| revoked or unknown | This Invite Isn't Valid | Check you opened the newest invite email. | Go to the Home Page |
| no fragment (opened as a bare `/invite`) | Open Your Invite Email | Tap the link in the email to accept. | Go to the Home Page |
| signed in as someone else | You're Signed In as a**@other.com | This invite is for y**@university.ac.uk. | Sign Out and Continue (primary), Go to Your Library (text) |
| signed in as the invitee already (the peek answers `forYou`) | (redirect to `/library`) | | |
| rate limited | Too Many Tries Right Now | Wait a minute, then open the link again. | none |

- Preview mode: `/invite` works only for invites to `TEST_EMAILS` (MODE-01); any other token peeks as "This Invite Isn't Valid", so preview leaks nothing.

## 6. Emails (what the pages promise must match)

- Code email subject "Your bloop Sign-In Code", never the code (plan A.10); first line of the body: "481 207 is your code. It works for 10 minutes." The page's "Enter the 6 digits from the email." matches it.
- Invite subject "You're Invited to bloop"; body: the same sentence as the page, the button text "Accept Invite", and "The invite works until 2 Dec."

## 7. Motion, targets, slow and offline

- State changes swap at once and move focus to the new title (as `/a`). No entrance animation; the toast's own motion only.
- Every button 52 tall, every text button a 44 hit area, the field 56.
- **Slow:** a request over 4 s keeps the spinner and adds the sentence row "Still working. Keep this page open."; at 15 s it stops with "That took too long. Try again." and re-enables the button.
- **Offline before submit:** the button stays enabled; a tap shows "You're offline. Check your connection, then try again." in the sentence row (no page state, nothing to lose).
- **Back** on the code step returns to the email step (one history entry), not off the site.

## 8. Strings (this file)

| Slot | String |
|---|---|
| email step | Sign In / Early access is by invite. Use the email your invite went to. / Email / Email Me a Code / Sign In with a Passkey / No invite? Join the waitlist. |
| Turnstile | Checking...; Turn off content blocking for bloop.here to sign in. / Try Again |
| code step | Check Your Email / If {email} has early access, a code is on its way. / A code is on its way to {masked}. / Code / Enter the 6 digits from the email. / Use a Different Email / Send a New Code / Send a New Code in 0:24 |
| code errors | That code didn't match. Try again. / That code has expired. Send a new one. / Too many tries. Send a new code. / Too many codes for now. Try again in 15 minutes. / You're offline. Check your connection, then try again. |
| passkey | Sign In Faster Next Time / Save a passkey on this phone. Your email code still works if you lose it. / Save a Passkey / Not Now / Passkey Saved / Next time, choose it when you sign in. / The passkey wasn't saved. Try again, or continue without it. |
| refused | This account can't sign in right now. Email hi@bloop.here. |
| invite | You're Invited / Early access to bloop for {masked}. / bloop puts your files on the room screen from your phone. The screen never gets your account. / The invite works until {date}. / By continuing you confirm you are 18 or over and accept the Terms. / Accept Invite; You're Signed In as {masked} / This invite is for {masked}.; and the peek states in section 5 |
| slow | Still working. Keep this page open. / That took too long. Try again. |

## 9. Preview mode

Preview must not advertise accounts or tell anyone who has one (MODE-01; README.md, Mode).

- `/signin` is served, looking exactly as in open, but nothing links to it: no nav pill, no landing hint, no link from `/a` (preview has no early-access state). It carries `<meta name="robots" content="noindex">` and is in neither the sitemap nor `llms.txt`. Admins and testers reach it by typing it or from an email.
- **One answer for every address.** The code request answers the same "if" line for any email ("If you@university.ac.uk has early access, a code is on its way."), in the same time, whether or not the address is allowed. The server sends a code only to an allowed account: by default any active member (members keep access in preview), and with `preview_lockout` on only an email in `ADMIN_EMAILS` or `TEST_EMAILS` that has an account (README.md, Mode). A visitor who tries learns nothing, and their inbox stays empty; a locked-out member gets the same silence, never a line that says why.
- Passkey sign-in works for allowed accounts; any other passkey is refused with the generic refusal (section 4), never a preview-specific line.
- `/invite` in preview: section 5's rule, only invites to `TEST_EMAILS`.
- Signed out, `/library`, `/account` and `/admin` answer the 404 page (never a redirect to `/signin`, which would advertise it); in open they redirect to `/signin?next=`. Signed in as an allowed account, they work in both modes.
- `?next=` keeps its allowlist in both modes; in preview a `next` to a page the account cannot use lands on `/library`.
