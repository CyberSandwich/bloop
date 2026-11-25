# ADR 0026: two launch modes, preview and open

Status: proposed. Fable reviews it before any code is written against it. Data model: ADR 0013 (`setting`, `admin_action`). Sign-in: ADR 0014. Pairing: ADR 0015. Caching: ADR 0023.

## Context
- v4 ships accounts, the library and the new landing page live tonight, but the public must not see them until the owner has paid the ICO fee, signed the Online Safety Act assessments and reviewed the account-era legal pages.
- Until then the account-free product (demo, live screen, guest send) must run exactly as today, and the owner plus test accounts must be able to use every new surface on the real deployment.
- Switching must need no deploy, and switching back must be allowed.
- Static pages are served from `dist/` through the Worker (`run_worker_first`, ADR 0010), so the Worker can choose which file answers a path.

## Decision

### The setting
- One D1 row: `setting` key `launch_mode`, value `preview` or `open` (zod). A missing row, an unknown value or a failed read is `preview`: the gate fails closed (MODE-01).
- **Read:** one function, cached per isolate for 30 s (module scope: value plus read time). `TEST_TIMING` sets the cache to 0 so tests see a switch at once. A D1 error with an expired cache answers `preview` and does not cache the error, so the next request retries. `/admin` reads the row uncached, so the owner always sees the truth.
- **Who changes it:** only `POST /api/admin/launch {mode, reason}`, Admin and C+R (ADR 0014). Nothing else writes the key: no variable, no secret, no script.
- **Consequence of the cache:** after a switch, an isolate may answer with the old mode for up to 30 s, and two isolates may disagree within that window. Every check reads the same function, so within one request the mode is consistent.

### The three logged ticks
- Keys `gate.ico` (ICO fee paid), `gate.osa` (OSA assessments signed), `gate.legal` (open-mode legal pages reviewed), value `'1'` when ticked. `POST /api/admin/gate {item, done, reason}`, Admin and C+R.
- Each tick, untick and mode change writes its setting row and an `admin_action` row (`target_kind = 'setting'`, `target_id` the key, `action` such as `tick`, `untick`, `launch.open`, `launch.preview`, the admin's `reason`) in one D1 batch, so no change happens unlogged (OSA-05).
- **Open needs all three, checked in the write itself:** the upsert to `open` is `INSERT ... SELECT ... WHERE (SELECT count(*) FROM setting WHERE key IN ('gate.ico','gate.osa','gate.legal') AND value = '1') = 3 ON CONFLICT (key) DO UPDATE ...`. Zero changes is `gate_incomplete`. A check in code before the write would race an untick.
- **Untick only in preview:** the untick statement is guarded by `launch_mode` not being `open`, so the gate cannot be open with a box clear.
- **Back to preview** needs no ticks and is always allowed.
- The rest of the launch-gate checklist (NCA reporting route, the first invite) is shown on `/admin` as information and is not enforced; the owner's launch-gate checklist owns the list.

### What each mode exposes
| surface | preview | open |
|---|---|---|
| landing, nav, Privacy, Terms, Security, articles | today's pages | the `/open/` variants (new hero, Sign In pill, waitlist block, account-era legal text) |
| demo, live screen `/s`, guest send | as today | as today |
| Present Live button, Sign In pill | absent (not in today's pages) | shown |
| early-access sheet on `/a` | never (ADR 0015) | shown to a signed-out phone on a live code |
| `/signin`, `/invite`, `/library`, `/account`, `/admin`, `/report` pages | served as inert shells, `noindex`, linked from nothing | served and linked |
| auth, library, upload, account APIs | `ADMIN_EMAILS` plus `TEST_EMAILS` only | every active member |
| invites created from `/admin` | to `TEST_EMAILS` only | any address |
| invite accept and code verify | invite email in `ADMIN_EMAILS` plus `TEST_EMAILS` | any open invite |
| Tally waitlist webhook, `/api/reports`, retention jobs | on | on |
| file origin (`/f/`, `/b/`, `/p/`) | on (test accounts' files) | on |

- **Why pages are served in preview:** before sign-in the Worker cannot know who is asking, so hiding a static shell by user is impossible. The shells hold no data; every API behind them applies the gate, so a visitor who types `/library` sees a sign-in form whose code request sends nothing. The landing page and nav in preview are today's files and link none of them.
- **The gate on the APIs, in one place:** in preview, a session whose user's `email_norm` is outside `ADMIN_EMAILS` plus `TEST_EMAILS` resolves as signed out (`GET /api/me` answers `signedIn: false`), so every C route refuses it and the claim route treats the phone as signed out. A code request for such an address writes its row and sends nothing (ADR 0014's uniform answer). Passkey sign-in refuses to create the session. `GET /api/me` also answers `launchMode`, so `/a` can decide whether to show the sheet.
- **Bootstrap:** the first admin's invite is written outside the routes by the owner's invite tool (ADR 0014); the route rule above stays strict.

### Page variants, chosen per request
- `build-pages` emits every page whose open version differs into an `open` folder of the build output, at the same relative path as its base. The Worker holds one constant list of those paths; a unit test fails if the list differs from what `build-pages` emits.
- For a GET or HEAD of a listed path in open mode, the Worker fetches `/open/<path>` from `ASSETS`; in preview, or for any unlisted path, it fetches the base. A direct request for any `/open/` path answers 404 in both modes, so preview can never be read through the variant's own URL (MODE-01).
- **Headers follow the requested path, not the asset path.** Cloudflare applies `_headers` by the asset's path, so `/open/` files would otherwise miss their page's CSP. F gives the `/open/` subtree the same rules as the base paths, and the headers drift test (`test/unit/headers.test.ts`) asserts each variant answers its base page's headers.
- **Caching:** HTML is `no-cache` with an ETag (ADR 0023). The variants have different ETags, so after a switch the next revalidation returns the other page with a 200. No purge and no deploy.

### Switching back
- Open to preview: new visitors get today's pages within 30 s. Members outside the test list resolve as signed out; their files stay stored and untouched, their open invites stay valid until expiry and work again if the mode reopens. A live session already approved runs to its end: the file-origin fetch checks the file and the user (ADR 0015), not the mode, so a talk in progress is not cut by a switch.

### Tests (MODE-01)
- Unit: missing, unknown and failing reads give `preview`; the cache honors 30 s and `TEST_TIMING`; the open upsert refuses with a tick missing; untick refuses while open; each write logs.
- Integration, in both modes: landing and legal bodies differ by mode; `/open/` is 404 in both; a non-test user's session is signed out in preview and signed in in open; invite create to a non-test address is refused in preview; code request for a non-test member sends nothing in preview (dev mailbox stays empty); a switch back to preview is seen on the next request under `TEST_TIMING`.
- e2e and the page tests run once per mode; the mode is set through the admin route by a test admin, the real path.

## Rejected
- **A Worker variable or secret for the mode:** a deploy to switch, which the decision rules out, and a second owner of the fact.
- **Two Worker deployments or two hosts:** doubles config and the file-origin split.
- **Rendering one page with hidden blocks:** preview would ship the open copy to every visitor in the HTML.
- **Client-side switching from `/api/me`:** a flash of the wrong page, and the open copy in every response.
- **KV for the setting:** a new binding for one row that D1 already holds, and KV's own propagation delay.
- **No cache:** one D1 read per page request for a value that changes a few times in the product's life.
- **Hiding the account pages with a 404 in preview:** the test accounts must reach them on the real host, and the Worker cannot tell them apart before sign-in.

## Consequences
- Every HTML request costs a cached read; at most one D1 read per isolate per 30 s.
- Both variants must pass html-validate, axe and the size budgets; CI runs both.
- The open copy of the legal pages is public in the repo before launch (it is in the source tree), but never served by the site until the switch. C's drafts must therefore contain nothing private.
- A test account list in a secret (`TEST_EMAILS`) is one more secret to keep in step with CI's fake addresses.

## Threats served
MODE-01 (preview never exposes the open surfaces or invites to non-test emails), OSA-05 (gate actions logged), AUTH-16 (the switch is Admin plus C+R).

## How to remove it
Once open is permanent: make the open pages the base pages in `build-pages`, delete the variant list, the `/open/` handling and the 404 rule, make `launchMode()` return `open` and then delete it and every call, and leave the `setting` rows and their `admin_action` history in place as the record of the gate.

## Flags (Part 2 unsafe, ambiguous or contradicting Part 1, and the resolution)
1. **Missing in Part 2:** the mode exists only in Part 1. Every Part 2 surface is mapped in the table above.
2. **Contradiction:** "`/signin`, `/library` and `/account` work for ADMIN_EMAILS plus TEST_EMAILS only" cannot apply to a static page before sign-in. Resolved: the pages are inert shells, the APIs carry the gate.
3. **Contradiction:** "invites only to TEST_EMAILS" leaves no way to create the first admin. Resolved: the owner's invite tool, outside the routes.
4. **Unsafe:** `_headers` would leave the variants without their page's CSP. Resolved: the subtree gets the same rules and the drift test checks it.
5. **Unsafe:** a check-then-write for the three ticks races an untick. Resolved: the guard is in the statement.
6. **Ambiguous:** what a switch back does to members and talks. Resolved above.
