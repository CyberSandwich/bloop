# Account, admin and report (`/account`, `/admin`, `/report`)

App pages (README.md, Shared rules). Account is a phone page first; admin is a desktop page that still works at 390, because the owner will flip a switch or revoke an invite from a phone. Routes: plan A.4.

## 1. `/account`

```
390 x 844                                        1440 (column max 640, centered)

  <Library                                         <Library

  Account                                                    Account
  you@university.ac.uk                                       you@university.ac.uk

  Email                                                      +---------------------------------------+
  +------------------------------------+                     | Email                                 |
  | you@university.ac.uk  ( Change )   |                     | you@university.ac.uk       ( Change ) |
  +------------------------------------+                     +---------------------------------------+
  Passkeys                                                   | Passkeys                              |
  +------------------------------------+                     | iCloud Keychain · Used today  (Remove)|
  | iCloud Keychain       ( Remove )   |                     | ( Add a Passkey )                     |
  | Used today                         |                     +---------------------------------------+
  | ( Add a Passkey )                  |                     | Signed-In Devices                     |
  +------------------------------------+                     | Safari on iPhone · This device        |
  Signed-In Devices                                          | Chrome on Mac · 3 days ago (Sign Out) |
  +------------------------------------+                     | ( Sign Out Everywhere )               |
  | Safari on iPhone                   |                     +---------------------------------------+
  | This device                        |                     | Screens Showing Your Files            |
  | Chrome on Mac       ( Sign Out )   |                     | Room 2.14 · Ends 11:35        [! End !]|
  | 3 days ago                         |                     +---------------------------------------+
  | ( Sign Out Everywhere )            |                     | Your Data                             |
  +------------------------------------+                     | ( Download Your Data )                |
  Screens Showing Your Files                                 | ( Delete Your Account )               |
  +------------------------------------+                     +---------------------------------------+
  | Room 2.14            [! End !]     |
  | Ends 11:35                         |                     [ Sign Out ]
  +------------------------------------+
  Your Data
  +------------------------------------+
  | ( Download Your Data )             |
  | ( Delete Your Account )            |
  +------------------------------------+
.--------------------------------------.
| [            Sign Out            ]   |
'--------------------------------------'
```

- Back reads "Library" (the house frame Back with its label; a labeled Back is allowed, as "Start Over"). Title "Account", the email under it (`--muted`).
- Each group: a group label (14/600 `--muted`), then a white `--r-card` box of rows. Rows 56 at least, two lines (the item row's type: 15/600 then 13 `--muted`), the row's action a text button at its end (44 hit area). The Library's Account icon leads here.
- **Email, Change:** reauth first (section 1.1), then a field "New Email" and Email Me a Code; the code goes to the new address, a notice to the old (plan A.10). Done: toast "Email Changed" / "Sign in with {new} from now on."
- **Passkeys:** one row per passkey: its name (from the authenticator, or "Passkey" when it gives none), line "Used today" / "Used 3 Nov" / "Never used". Remove asks: "Remove This Passkey?" / "You can still sign in with an email code." / Cancel, Remove (rose); it needs reauth. Add a Passkey runs section 3 of signin.md (create). No passkey support: the group says "This browser can't save passkeys. Your email code always works." and no Add.
- **Signed-In Devices:** one row per sign-in: the label ("Safari on iPhone"), line "This device" or "Signed in 3 days ago". Sign Out on a row ends it at once (no question; signing in again is cheap). Sign Out Everywhere asks: "Sign Out Everywhere?" / "Every device, this one too, needs an email code or passkey next time." / Cancel, Sign Out Everywhere (rose).
- **Screens Showing Your Files:** live screens only (`GET /api/me/screens`); each with End (rose), which ends it without a question (it is the phone's Revoke, from elsewhere; the room's PC shows Session Ended). None: the group shows "No screens are showing your files." Updates over the library socket while the page is open.
- **Your Data:** Download Your Data (reauth, then a zip download begins: originals plus a data file; the row shows "Preparing your download..." then the browser's own download UI; it streams, so nothing waits server side); Delete Your Account (section 1.2).
- **Sign Out** (secondary, the action panel): signs out this device and goes to the landing.
- Focus: the title on load; groups in reading order.
- Lazy: export, delete and email change on pointerdown or focus of their buttons; passkey create on Add a Passkey.

### 1.1 Reauth (C+R: within 5 minutes)

A sheet (the Session Expiry pattern): "Confirm It's You" / "Use your passkey, or get a code at you@university.ac.uk." / Use Passkey (primary, where one exists) / Email Me a Code (secondary). The code step is signin.md section 2 inside the sheet. Done: the sheet closes and the action that asked continues by itself, so nobody taps it twice.

### 1.2 Delete Your Account

```
390, after reauth

  Delete Your Account?
  Your files, library and history are
  deleted 7 days from now. Until then,
  signing in cancels it.

  Type DELETE to confirm
  +------------------------------------+
  |                                    |
  +------------------------------------+
.--------------------------------------.
| [!     Delete My Account        !]   |
| [            Cancel              ]   |
'--------------------------------------'
```

- A page state (not a sheet: it is the page's whole subject while it shows). The rose button enables when the field holds "DELETE" (any case).
- Done: signed out everywhere, the landing with toast "Account Deletion Scheduled" / "Sign in before 2 Dec to cancel it." and the deletion email (plan A.10).
- Signing in during the grace: the library shows its "Your account is deleted on 2 Dec." card with Cancel Deletion (library.md section 9).

## 2. `/admin`

Admin only (`ADMIN_EMAILS`, checked on every request); anyone else gets the 404 page. A wide page: content max 1136.

```
1440 x 900

 [b bloop]                                                                      [(user)]

            Admin                                                   Mode: Preview (amber chip)

            [ Invites ] [ Waitlist ] [ Reports 2 ] [ Users ] [ Launch ]    segmented tabs

            +-------------------------------------------------------------------------+
            | New Invite                                                              |
            | Email +-------------------------+  Note +-------------------+ [[ Create Invite ]] |
            +-------------------------------------------------------------------------+
            +-------------------------------------------------------------------------+
            | Email                  Status       Sent        Expires     Actions     |
            | ann@uni.ac.uk          Open         2 Dec 10:02  9 Dec       (Copy Link) (Resend) (Revoke) |
            | bo@uni.ac.uk           Accepted     1 Dec        (none)                  |
            | cy@uni.ac.uk           Expired      20 Nov       27 Nov      (Resend)    |
            +-------------------------------------------------------------------------+
```

```
390 (tabs scroll sideways in one row; tables stack as the legal pages' tables do under 640)

  [b bloop]                       [(user)]
  Admin                 Preview (amber chip)
  [ Invites ][ Waitlist ][ Reports 2 ][ Us >
  +------------------------------------+
  | New Invite                         |
  | Email                              |
  | +--------------------------------+ |
  | Note                               |
  | +--------------------------------+ |
  | [[        Create Invite         ]] |
  +------------------------------------+
  +------------------------------------+
  | ann@uni.ac.uk                      |
  | Open · Sent 2 Dec · Expires 9 Dec  |
  | (Copy Link) (Resend) (Revoke)      |
  +------------------------------------+
```

- **Mode chip** by the title: "Preview" (`--amber` pair) or "Open" (`--mint` pair), the Connect panel's status chip; it links to the Launch tab.
- **Tabs:** the segmented tabs (README.md additions). Reports shows its open count. Each tab is its own lazy module on pointerdown; the URL keeps the tab (`/admin#reports`), so a reload stays.
- **Tables:** the legal pages' table (design.md section 6, Legal pages: white card, 15 px, heads 14/600 `--muted`, rows split by a hairline, stacking under 640 with each value's column name above it).

### 2.1 Invites

- New Invite: Email (required), Note (optional, at most 200), Create Invite. Done: the link shows once, in a row above the table: the link in a read-only field (house frame, Lucide `copy` at its start, as the room's code card: a click copies and shows `check` for 1.5 s) and "This link shows once. The invite email has been sent too." In preview mode only `TEST_EMAILS` are accepted: "Preview mode sends invites to test emails only." under the field when another is typed, the button disabled.
- Statuses: Open, Accepted, Expired, Revoked. Actions per status: Open: Copy Link (only right after create; later the link is gone, so Resend), Resend (a new link, the old one dies; toast "Invite Resent"), Revoke (asks "Revoke This Invite?" / "The link stops working." / Cancel, Revoke (rose)). Expired: Resend.
- Empty: "No invites yet." in the table's place.

### 2.2 Waitlist

- Rows from the Tally webhook: email, joined date, source, the answers (one line, expandable). Actions: Invite (prefills New Invite with the email and links the row; it moves to Invited), Dismiss (asks nothing; undo toast).
- Empty: "No one is on the waitlist yet." Webhook not set up (no secret): a warn card "Waitlist entries arrive once the Tally webhook is set up." with a link to the setup doc's section.

### 2.3 Reports

- Rows: when, channel (screen or page), category, the detail (first line, expandable), the file (name, owner's masked email), status. Actions: Disable File / Enable File, Suspend Owner, Keep a Copy (the NCA hold), Resolve. Each needs a reason (a field in the sheet that opens, at most 500), logged.
- Disable asks "Disable {name}?" / "It stops opening anywhere, at once. The owner sees why." / Cancel, Disable (rose).
- Empty: "No reports. New ones appear here and by email."

### 2.4 Users

- Rows: masked email, joined, last active, storage used, status (Active, Suspended, Deleting). Actions: Suspend / Unsuspend (with a reason), Send Sign-In Link (the email fallback: single use, 15 minutes; shows once like an invite link).
- Search by email (exact match on the normalized address; no listing by partial match beyond the visible page).

### 2.5 Launch: the mode switch and the checklist

```
1440, Launch tab

  +-------------------------------------------------------------------------------+
  | Launch Mode                                                    Preview (chip) |
  | Preview shows today's site to everyone. Accounts work for admins and test      |
  | emails only.                                                                   |
  +-------------------------------------------------------------------------------+
  +-------------------------------------------------------------------------------+
  | Before You Open                                                                |
  | [x] ICO fee paid                                  Ticked by you, 2 Dec 10:02  |
  | [ ] Online Safety Act assessments signed                                      |
  | [ ] Open-mode legal pages reviewed                                            |
  |                                                                               |
  | Also on the launch list (not ticked here): register an NCA reporting route;   |
  | send the first invite.                                                        |
  |                                                                               |
  | [[ Switch to Open ]]   (disabled until all three are ticked)                  |
  +-------------------------------------------------------------------------------+
```

- Launch Mode card: the current mode chip and one sentence: Preview: "Preview shows today's site to everyone. Accounts work for admins and test emails only." Open: "Open shows the new site, and invites go to anyone."
- **Before You Open:** three checkboxes, rows 52 tall: "ICO fee paid", "Online Safety Act assessments signed", "Open-mode legal pages reviewed". Each tick is logged (`admin_action`) and shows who and when on the right; an untick is logged too. The rest of the launch gate (NCA route, first invite) is listed as text, since the switch does not depend on it (the launch gate checklist the lead keeps outside the repo owns the full list; the page shows only these lines).
- **Switch to Open** (primary) is disabled until the three are ticked (with the line "Tick all three to switch." under it). A tap asks: "Switch to Open?" / "The new site and sign-in go live for everyone within 30 seconds. You can switch back." / Cancel, Switch to Open (primary, not rose: opening is not destructive). Done: the chip turns Open, toast "Open Mode Is On" / "Pages switch within 30 seconds."
- **Switch to Preview** (secondary, in open mode) asks: "Switch Back to Preview?" / "Signed-in users keep working; the public site goes back to today's." / Cancel, Switch to Preview.
- Why the 30 seconds is said: the setting is cached per isolate for 30 s (plan Part 1, Two modes), and an owner who reloads at once and sees the old page would think it failed.
- 390: the same cards stacked; the switch in the bottom action panel.

## 3. `/report`

Reached from the screen's Report link, a footer link on the open-mode site, or a URL in an email. Anyone can send one, signed in or not.

```
390                                              1440 (column max 480)

  <Back

  Report a File                                            Report a File
  Tell bloop what's wrong. Reports are                     Tell bloop what's wrong. Reports are
  read by a person, usually within a day.                  read by a person, usually within a day.

  What's wrong?                                            (same fields)
  ( ) It's illegal
  ( ) It harms or targets someone
  ( ) It's sexual content involving a child
  ( ) It infringes my rights
  ( ) Something else
  Details
  +------------------------------------+
  |                                    |
  +------------------------------------+
  Your email (optional, for a reply)
  +------------------------------------+
.--------------------------------------.
| [[          Send Report           ]] |
'--------------------------------------'
```

- Title "Report a File"; line "Tell bloop what's wrong. Reports are read by a person, usually within a day." (the response time is C's to confirm in the moderation process; until then the line ends at "person.").
- Category: a radio group "What's wrong?" (the categories are C's from the OSA assessment; these are the draft). Details (a textarea, at most 2000, a counter from 1800: "1,950 of 2,000"). Email optional. Turnstile on submit (invisible, as sign-in).
- From the screen's link the page carries the screen's channel and says above the form "About the file on Room 2.14 at 10:42." (the server's words; the page never sees a file id).
- Sent: "Report Sent" / "Thank you. If you left an email, a reply comes from hi@bloop.here." / Done.
- The child-safety category adds, once chosen, a line in `--ink` 600 with `triangle-alert`: "If a child is in danger now, call 999." No tint (the warn card).

## 4. Strings (this file)

| Slot | String |
|---|---|
| account | Account; Library (Back); Email; Change; New Email; Email Changed / Sign in with {new} from now on.; Passkeys; Passkey; Used today; Used 3 Nov; Never used; Remove; Remove This Passkey? / You can still sign in with an email code.; Add a Passkey; This browser can't save passkeys. Your email code always works.; Signed-In Devices; This device; Signed in 3 days ago; Sign Out; Sign Out Everywhere; Sign Out Everywhere? / Every device, this one too, needs an email code or passkey next time.; Screens Showing Your Files; Ends 11:35; End; No screens are showing your files.; Your Data; Download Your Data; Preparing your download...; Delete Your Account |
| reauth | Confirm It's You / Use your passkey, or get a code at {email}. / Use Passkey / Email Me a Code |
| delete | Delete Your Account? / Your files, library and history are deleted 7 days from now. Until then, signing in cancels it. / Type DELETE to confirm / Delete My Account / Cancel; Account Deletion Scheduled / Sign in before {date} to cancel it. |
| admin | Admin; Preview; Open; Invites; Waitlist; Reports; Users; Launch; New Invite; Note; Create Invite; This link shows once. The invite email has been sent too.; Preview mode sends invites to test emails only.; Copy Link; Resend; Invite Resent; Revoke; Revoke This Invite? / The link stops working.; Accepted; Expired; Revoked; No invites yet.; Invite; Dismiss; No one is on the waitlist yet.; Waitlist entries arrive once the Tally webhook is set up.; Disable File; Enable File; Suspend Owner; Keep a Copy; Resolve; Disable {name}? / It stops opening anywhere, at once. The owner sees why.; No reports. New ones appear here and by email.; Active; Suspended; Deleting; Suspend; Unsuspend; Send Sign-In Link |
| launch | Launch Mode; Preview shows today's site to everyone. Accounts work for admins and test emails only.; Open shows the new site, and invites go to anyone.; Before You Open; ICO fee paid; Online Safety Act assessments signed; Open-mode legal pages reviewed; Ticked by you, {date}; Switch to Open; Tick all three to switch.; Switch to Open? / The new site and sign-in go live for everyone within 30 seconds. You can switch back.; Open Mode Is On / Pages switch within 30 seconds.; Switch to Preview; Switch Back to Preview? / Signed-in users keep working; the public site goes back to today's. |
| report | Report a File / Tell bloop what's wrong. Reports are read by a person, usually within a day. / What's wrong? / Details / Your email (optional, for a reply) / Send Report / About the file on {room} at {time}. / Report Sent / Thank you. If you left an email, a reply comes from hi@bloop.here. / Done / If a child is in danger now, call 999. |
