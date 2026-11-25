# Empty, error, slow and offline: every surface

One table per surface. The rules every row follows:

- **Error copy** is design.md's: what happened, no blame, what to do, one verb button.
- **Slow** has two steps everywhere: at 4 s a line saying it is still working (the loader or spinner stays), at 15 s a stop with Try Again, except where a stop would lose work (an upload, an approve that may have landed), which keep waiting with a line instead.
- **Offline** is detected by a failed request, not by `navigator.onLine` alone (a captive portal reports online); `online` and `visibilitychange` trigger the retry.
- **Skeletons** only where text length is unknown; everything with a known shape holds its box (CLS 0 on app pages).
- **In-between states** each get a visible change within 100 ms of the tap: a press scale, a spinner label, a filled choice. A tap that shows nothing for 300 ms reads as ignored.

## 1. Landing (both modes)

| Case | Shows |
|---|---|
| slow | the HTML and h1 paint first; the stage picture holds its box on `--g1` |
| offline (cached) | the cached page; links that need the network fail in the browser's own way |
| no script | full page; the open variant's pill label comes from the Worker |
| Tally unreachable | Tally's own page; nothing on bloop changes |

## 2. `/signin`, `/invite`

| Case | Shows |
|---|---|
| first paint | the email step immediately (no fetch needed); `/invite` shows a skeleton title until peek answers |
| slow request | "Still working. Keep this page open." at 4 s; "That took too long. Try again." at 15 s |
| offline | "You're offline. Check your connection, then try again." in the sentence row |
| Turnstile blocked | "Turn off content blocking for bloop.here to sign in." / Try Again |
| rate limited | code: "Too many codes for now. Try again in 15 minutes."; invite: "Too Many Tries Right Now" |
| server error | "Something went wrong on bloop's side. Try again in a minute." / Try Again |
| cookies blocked (the session cookie did not stick after verify) | "Your browser blocked sign-in. Allow cookies for bloop.here, then try again." |
| passkey sheet canceled | nothing changes |
| invite expired, used, revoked | signin.md section 5 table |

## 3. `/library`

| Case | Shows |
|---|---|
| first visit, nothing yet | the empty state (library.md section 8) |
| loading, cold | title and quota skeletons, 4 skeleton rows; Present disabled |
| loading, warm | the cached list at once, refreshed in place |
| slow list (4 s) | the skeleton stays and "Still loading your library." under it; 15 s: "Your Library Didn't Load" / "Check your connection, then try again." / Try Again |
| offline | toast "You're Offline" / "Your library will update when you're back."; the list read only; every write refused with the same toast |
| socket blocked (campus proxy) | polling every 10 s while a row prepares; no message (nothing is wrong for the user) |
| a file preparing a long time (over 5 minutes) | the row's chip stays "Preparing Slides"; the preview line adds "This one is taking longer than usual." |
| conversion failed | rose chip "Can't Show Slides" with the reason; PowerPoint still opens it |
| quota full | the quota line's warning; Add Files explains on tap |
| trash empty | "The Trash Is Empty" / "Files you delete stay here for 30 days." |
| signed out | open: to `/signin?next=/library`; preview: the 404 page (README.md, Mode) |
| suspended, deleting | library.md section 9 |
| a lazy module failed | toast "That Didn't Load" / "Reload the page, then try again." / Reload |

## 4. Upload pill

| Case | Shows |
|---|---|
| slow link | the fill moves slowly; the time left appears after 5 s |
| offline mid upload | "Waiting for a Connection"; resumes by itself |
| phone locked | Wake Lock where available; otherwise the waiting state on return, then resume |
| tab reloaded | "{name} Is Paused" / "Choose the file again to finish." / Choose File |
| refused | the toasts in upload.md section 4 |
| module failed | "Upload Didn't Load" / Reload |

## 5. `/a` (phone, live with accounts)

| Case | Shows |
|---|---|
| checking slow (4 s) | "Still checking. Keep this page open." under the skeleton |
| checking, 15 s | "You're Offline" state (as today) with Try Again |
| signed out, open mode | Early Access Only (present-live.md section 5) |
| signed out, preview | today's flow |
| `/api/me` fails but the claim works | treated as signed out only if the claim says `auth_required`; otherwise the claim's answer wins |
| match module slow | three skeleton pills of the same size |
| approving slow (4 s) | "Still approving. Keep this page open." under the choices; no 15 s stop, since the approve may have landed |
| answer lost between match and approve | a retap of the same number is a no-op success (match is idempotent for the confirmed number); the client resumes at approve |
| wrong number | "That Wasn't the Screen's Number" / "Scan the screen again, or type its code." (present-live.md 3.3) |
| code expired before the tap | "This Code Has Expired" (as today) |
| approve refused after the match | the chooser with a toast (present-live.md 3.3) |
| library empty, nothing packed | the chooser shows "Your Library Is Empty" / "Add files in your library, or send one file now." / Add a File (text, the guest path for this screen) and Done |
| resume after sign-in, code gone | "Scan the Screen Again" |
| notes slow | the Notes card holds a skeleton line until they arrive; failed: no card (the talk goes on) |
| offline while approved | as today (Revoke, Try Again) |

## 6. `/s` (room screen)

| Case | Shows |
|---|---|
| first slide slow (3 s, 15 s) | viewers.md section 3 |
| file origin blocked | silent fallback to bloop.here links (FO-01) |
| viewer module failed | the item's file card with Download in the pill: "This File Can't Be Shown Here" / "Download it, or open it from your phone." |
| PowerPoint did not open | slides in bloop with the "PowerPoint Didn't Open" toast (viewers.md section 5); a deck with no slides yet: today's open fallback |
| conversion not ready at approval | the deck opens in PowerPoint as today; Show Slides Here appears in the pill once `derivedReady` arrives |
| file removed mid talk | "This File Isn't Available Anymore" card (viewers.md section 8) |
| guest upload paused | "Waiting for the Phone" in the receiving pill |
| offline, service down, rate limited | as today (design.md section 7) |

## 7. `/account`

| Case | Shows |
|---|---|
| loading | each group's box at its row count from cache, else 1 skeleton row each |
| no passkeys | the group's line "No passkeys yet." and Add a Passkey |
| no passkey support | "This browser can't save passkeys. Your email code always works." |
| no live screens | "No screens are showing your files." |
| export slow | "Preparing your download..." stays until the browser's download starts; 30 s: "Your download is taking a while. It starts by itself." |
| reauth canceled | the sheet closes; the action does not run |
| a write fails | toast "That Didn't Save" / "Check your connection, then try again." |

## 8. `/admin`

| Case | Shows |
|---|---|
| empty tabs | the empty lines in account-admin.md section 2 |
| a tab module failed | "This Tab Didn't Load" / Reload in the tab's place |
| action refused (not admin any more, rate limit) | toast with the server's reason; the row unchanged |
| mode switch slow | the button's spinner, "Switching..."; the chip changes only on the server's answer |
| checklist tick fails | the box returns to its last saved state with toast "That Didn't Save" |

## 9. `/report`

| Case | Shows |
|---|---|
| Turnstile blocked | as sign-in |
| slow submit | "Sending..." on the button; 15 s: "That took too long. Try again." |
| offline | "You're offline. Your report is still here, so try again when you're back." (the form keeps its text) |
| rate limited | "Too many reports from here right now. Try again in an hour, or email hi@bloop.here." |

## 10. Perceived speed, by surface

- **Landing to Library:** the pill's label is right on first paint, and `/library` paints its cached list before the fetch returns.
- **Scan to slide:** the match pick's module is fetched while the claim is in flight; the screen's QR card shows the number before the phone needs it; the first slide's 480 thumbnail is already decoded from the library, so the screen fades the full image over it.
- **Row tap to preview:** the preview link and the viewer module are fetched on pointerdown, about 100 ms before the click.
- **Upload:** the row exists from the first byte, so the library never looks empty during a first upload.

## 11. Strings (only in this file)

Something went wrong on bloop's side. Try again in a minute.; Your browser blocked sign-in. Allow cookies for bloop.here, then try again.; Still loading your library.; Your Library Didn't Load / Check your connection, then try again.; This one is taking longer than usual.; Still checking. Keep this page open.; Your Library Is Empty / Add files in your library, or send one file now.; This File Can't Be Shown Here / Download it, or open it from your phone.; No passkeys yet.; Your download is taking a while. It starts by itself.; That Didn't Save / Check your connection, then try again.; This Tab Didn't Load; Switching...; Sending...; You're offline. Your report is still here, so try again when you're back.; Too many reports from here right now. Try again in an hour, or email hi@bloop.here.
