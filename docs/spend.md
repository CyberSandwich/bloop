# Spend guard

The owner doc for every switch, cap and breaker line. Why a Durable Object and how to remove it: `docs/adr/0029-spend-guard.md`. The code is `src/worker/spend/`; nothing else restates these numbers.

Cloudflare's spend limits cover only Workers and Durable Objects. Containers, R2, D1, Workflows, Email and Logs have no platform ceiling, so these caps are the ceiling. Three layers, each with one job:

- **Switches** turn a feature off in seconds with no deploy (section 1).
- **Caps** are exact counters and pools in one Durable Object, `SpendGuard`, that refuse work past a number (sections 2 to 4).
- **The breaker** runs every 5 minutes, flips the matching switch when a daily figure crosses its line, and stays flipped until the owner resets it (section 5).

## 1. Switches

A switch is a D1 `setting` row (key, value). The value in force is the more restrictive of the Worker var and the row, so the var is a floor a deploy can set. With no row, the default applies. A value a switch does not allow, in the row or the var, counts as the most restrictive. Allowed values run from least to most restrictive; `src/worker/spend/switches.ts` is the registry and `effectiveSwitch` is the merge.

| switch | var | values | default | stops |
|---|---|---|---|---|
| `launch_mode` | `SWITCH_LAUNCH_MODE` | open, preview | preview | the open-mode site and invites (ADR 0026) |
| `guest_files` | `SWITCH_GUEST_FILES` | on, stopped | on | every guest path: live and demo drops, guest opens, guest reads of `/f/` and `/b/` |
| `guest_drop` | `SWITCH_GUEST_DROP` | open, pass, off | open | the live-room guest drop policy |
| `demo` | `SWITCH_DEMO` | on, off | on | demo creates and claims |
| `demo_drop` | `SWITCH_DEMO_DROP` | on, off | on | the demo's guest drop only; the demo deck keeps working |
| `uploads` | `SWITCH_UPLOADS` | on, readonly, off | on | library uploads and part URLs; readonly keeps existing files present and downloadable |
| `convert` | `SWITCH_CONVERT` | on, account_only, off | account_only | account_only refuses guest and live conversions (the demo profile is the one public path); off starts no container |
| `convert_video` | `SWITCH_CONVERT_VIDEO` | on, off | on | the ffmpeg stage only |
| `email` | `SWITCH_EMAIL` | on, admin_only, off | on | Email sends; admin_only keeps `/admin` invites and copy-link |
| `signin_code` | `SWITCH_SIGNIN_CODE` | on, off | on | code sign-in requests; passkeys stay |
| `invites` | `SWITCH_INVITES` | on, off | on | invite create, resend and accept |
| `file_origin` | `SWITCH_FILE_ORIGIN` | workers_dev, main, off | workers_dev | main mints file links on the main origin and the workers.dev host answers 404; off serves no files |
| `export` | `SWITCH_EXPORT` | on, off | on | the library export |
| `previews` | `SWITCH_PREVIEWS` | on, off | on | owner previews and library thumbnails |
| `breaker` | `SWITCH_BREAKER` | auto, alert_only | auto | alert_only keeps alerts and stops automatic flips |

`convert` defaults to account_only: the public internet starts a container only through the demo profile (at most 40 pages, two sizes, no video). Set the row to `on` to allow guest conversions.

### Flip and reset

- **Flip now:** `/admin` switch panel writes the row and logs `admin_action`. Effective within 30 seconds (the per-isolate cache).
- **Flip with D1 or `/admin` unreachable:** `wrangler deploy --var SWITCH_UPLOADS:off` from the owner's machine, then commit the same value to `wrangler.jsonc`. A var is a floor: a row can make it stricter, never looser. Remove the var to lift it.
- **Reset after a breaker trip:** `/admin` calls `resetBreaker`, which clears the latch in the SpendGuard, sets the row back to its default and logs it. Setting the row by hand does not release the latch: the next run puts the flip back.
- **Stop the automatic flips:** set `breaker` to alert_only. Alerts continue; the breaker names what it would have flipped.

## 2. What the guard keeps

All counts are global, exact and per UTC period. A meter with a per-scope limit also keeps its all-scopes count, which is what the breaker reads. A refused take adds nothing and writes nothing.

| meter | counts | limits (cap names in section 3) |
|---|---|---|
| `container_seconds` | stage-timeout seconds charged at container start, refunded on finish | day |
| `convert_user` | conversions per account | day, per user |
| `convert_guest` | guest conversions | day, per IP hash |
| `convert_demo` | demo conversions | day, and day per IP hash |
| `conversion_done`, `conversion_failed` | finished and failed conversions | none; the breaker reads them |
| `r2_class_a`, `r2_class_b` | R2 operations | month |
| `upload_user`, `upload_user_bytes` | library uploads and bytes | day, per user |
| `guest_drop` | guest drops | day, per IP hash |
| `email` | sends | hour and day |
| `email_recipient` | sends per recipient hash | day, per recipient |
| `email_code` | sign-in code requests | day, per IP hash |
| `export_user` | exports | day, per user |
| `demo_session` | demo sessions | day |
| `d1_writes` | bloop's own D1 row writes | none |

Pools hold a lease that frees itself: `convert` (accounts), `convert_public` (guest and demo), `export`. A lease has a deadline (the requested time, at most the pool's maximum). The Converter destroys its container at the deadline. An unreleased lease keeps its slot through the grace, then is dropped and counted; the breaker turns `convert` off on any overdue or dropped lease, because a container may still be running.

## 3. Caps

Each cap has a default in `src/worker/spend/caps.ts` and a var that replaces it; the var is the maximum. A `cap.<name>` row from `/admin` can lower a cap and never raise it (`setOverrides`). A var that is not a number of at least 0 is ignored. None of these vars is in `wrangler.jsonc`; set one with `wrangler deploy --var`.

| var | default | reason |
|---|---|---|
| `CAP_POOL_CONVERT` | 3 | account conversions at once; a lecture-hour peak |
| `CAP_POOL_CONVERT_PUBLIC` | 1 | guest and demo conversions at once, so the public cannot starve accounts |
| `CAP_POOL_EXPORT` | 4 | exports at once account-wide; each streams a library in Worker CPU |
| `CAP_POOL_EXPORT_PER_USER` | 1 | one export at a time per user |
| `CAP_LEASE_CONVERT_SECONDS` | 1800 | longest a conversion lease may be asked for; the stage timeouts add to about 22 minutes |
| `CAP_LEASE_EXPORT_SECONDS` | 900 | longest an export lease may be asked for |
| `CAP_LEASE_GRACE_SECONDS` | 300 | an unreleased lease keeps its slot this long past its deadline |
| `CAP_CONTAINER_SECONDS_DAY` | 21600 | 6 instance-hours a day: about $0.77 a day on standard-2 |
| `CAP_CONVERT_USER_DAY` | 20 | conversions per account per day; a heavy day is 5 to 10 decks |
| `CAP_CONVERT_GUEST_IP_DAY` | 10 | guest conversions per IP hash per day |
| `CAP_CONVERT_DEMO_DAY` | 200 | demo conversions per day, all visitors |
| `CAP_CONVERT_DEMO_IP_DAY` | 10 | demo conversions per IP hash per day |
| `CAP_R2_CLASS_A_MONTH` | 1,500,000 | class A operations per UTC month; 0.5M over the free 1M costs $2.25 |
| `CAP_R2_CLASS_B_MONTH` | 15,000,000 | class B operations per UTC month; 5M over the free 10M costs $1.80 |
| `CAP_UPLOAD_USER_DAY` | 50 | library uploads per account per day |
| `CAP_UPLOAD_USER_BYTES_DAY` | 10,737,418,240 | 10 GiB uploaded per account per day; a purge does not give bytes back |
| `CAP_GUEST_DROP_IP_DAY` | 20 | guest drops per IP hash per day; a busy seminar behind one NAT |
| `CAP_EMAIL_HOUR` | 60 | sends per hour account-wide |
| `CAP_EMAIL_DAY` | 300 | sends per day account-wide; 1,000 users need about 170 |
| `CAP_EMAIL_RECIPIENT_DAY` | 10 | sends per recipient per day |
| `CAP_EMAIL_CODE_IP_DAY` | 20 | sign-in code requests per IP hash per day |
| `CAP_EXPORT_USER_DAY` | 3 | exports per account per day |
| `CAP_DEMO_SESSION_DAY` | 2000 | demo sessions per day, all visitors |

## 4. What a caller does on refusal

Every call goes through `spendFor(env)` (`src/worker/spend/guard.ts`), which fails closed: a guard that cannot be reached refuses (`unavailable`). Presenting an already-converted file never calls it. `refusal(result)` returns the response to send.

| result | status | code | header |
|---|---|---|---|
| `cap_hit` | 429 | `rate_limited` | `Retry-After` seconds to the end of the period |
| `busy` | 503 | `service_busy` | `Retry-After`, at most 60 |
| `unavailable` | 503 | `service_busy` | `Retry-After` 30 |

Calls, by stream. A caller checks its switch first and calls the guard second.

| stream | calls |
|---|---|
| uploads | `take("upload_user", 1, userId)` and `take("upload_user_bytes", bytes, userId)` at create; `take("guest_drop", 1, ipHash)` per guest drop; `take("r2_class_a", 1)` per part URL minted |
| conversion | per request: `take("convert_user", 1, userId)`, `take("convert_guest", 1, ipHash)` or `take("convert_demo", 1, ipHash)`: 429. In the Workflow: `acquire("convert" or "convert_public", ttlSeconds, scope)`; busy means `step.sleep(retryAfterSeconds)` and try again, never a loop; `take("container_seconds", stageTimeoutSum)` before `start()` and `refund` of the unused part with the time of the take; a refusal marks the derived row failed once. `release(leaseId)` in `finally`. `record("conversion_done" or "conversion_failed", 1)` |
| accounts | `take("email", 1)`, `take("email_recipient", 1, recipientHash)`, `take("email_code", 1, ipHash)` before a send: 429, and the code route says "Try Your Passkey or Ask for a Sign-In Link" |
| library | `acquire("export", 900, userId)` and `take("export_user", 1, userId)` |
| present server | `take("demo_session", 1)` before a demo create |

## 5. The breaker

`runSpendBreaker(env)` runs on the `*/5 * * * *` cron. It reads the guard's exact counters and, when `CF_ANALYTICS_TOKEN` and `CF_ACCOUNT_ID` are set, the GraphQL Analytics API (Account Analytics Read only). With no token it uses counters alone and every alert says "counters only". It then:

1. latches each trip in the guard, writes the switch row as actor `breaker` with an `admin_action` line, and sends one alert per trip (a failed write or alert is retried next run);
2. sends a warning at most once per rule per UTC day;
3. never loosens a switch; a stricter trip on the same switch is a new trip and a new alert;
4. sends one alert when analytics fails 3 runs in a row.

An alert holds numbers only: no file names, addresses or user data. Until email is wired the alert is a log line `{"evt":"breaker",...}`.

| rule | line | acts |
|---|---|---|
| a capped daily meter reaches its cap: `container_seconds`, `convert_demo`, `demo_session`, `email` | `BREAKER_TRIP_PCT` percent of the cap | `convert=account_only`, `demo_drop=off`, `demo=off`, `email=admin_only` |
| the same meters past the warn line | `BREAKER_WARN_PCT` percent of the cap | alert |
| R2 class A or B in a month | `BREAKER_MONTH_WARN_PCT` percent of the cap | alert |
| R2 class A in a day, counted or from analytics (presigned PUTs are not counted in the Worker) | trip line below | `uploads=readonly` |
| guest drops in a day | two lines below | `demo_drop=off`, then `guest_files=stopped` |
| live conversion leases | more than `BREAKER_LEASES_LIVE_MAX` | `convert=off` |
| a lease past its deadline, or dropped | any | `convert=off` |
| failed conversions | more than `BREAKER_CONVERT_FAILED_PCT` percent of at least `BREAKER_CONVERT_FAILED_MIN` | `convert=account_only` |
| analytics readings (Workers, Durable Objects, R2 storage, D1) | lines below | alert only |

| var | default | line |
|---|---|---|
| `BREAKER_TRIP_PCT` | 100 | percent of a daily cap that trips its switch |
| `BREAKER_WARN_PCT` | 50 | percent of a daily cap that warns |
| `BREAKER_MONTH_WARN_PCT` | 80 | percent of a monthly cap that warns |
| `BREAKER_LEASES_LIVE_MAX` | 4 | live conversion leases that mean a leak |
| `BREAKER_CONVERT_FAILED_PCT` | 20 | failed conversions as a percent of the day's |
| `BREAKER_CONVERT_FAILED_MIN` | 10 | conversions needed before the percent counts |
| `BREAKER_GUEST_DROPS_DEMO_OFF_DAY` | 1,000 | guest drops in a day: demo drop off |
| `BREAKER_GUEST_DROPS_FILES_STOPPED_DAY` | 3,000 | guest drops in a day: guest files stopped |
| `BREAKER_R2_A_DAY_WARN` | 50,000 | R2 class A operations in a day: warn |
| `BREAKER_R2_A_DAY_TRIP` | 250,000 | R2 class A operations in a day: uploads read-only |
| `BREAKER_R2_B_DAY_WARN` | 500,000 | R2 class B operations in a day: warn |
| `BREAKER_R2_STORAGE_BYTES_WARN` | 100,000,000,000 | R2 bytes stored: warn |
| `BREAKER_D1_ROWS_DAY_WARN` | 1,500,000 | D1 rows written in a day: warn |
| `BREAKER_WORKERS_REQ_DAY_WARN` | 1,000,000 | Worker requests in a day: warn |
| `BREAKER_WORKERS_SPIKE_MULTIPLE` | 3 | Worker requests over this multiple of the trailing 7-day mean: warn |
| `BREAKER_WORKERS_SPIKE_FLOOR` | 50,000 | a spike must also pass this many requests |
| `BREAKER_DO_REQ_DAY_WARN` | 150,000 | Durable Object requests in a day: warn |
| `BREAKER_DO_GBS_DAY_WARN` | 30,000 | Durable Object GB-seconds in a day: warn |
| `BREAKER_ANALYTICS_FAIL_RUNS` | 3 | consecutive runs with a failed analytics read before the alert |

The guest-drop lines and the R2 class A daily trip line are G's numbers, not from the cost plan's table; the rest come from it.

## 6. Fails closed, and what stays open

- Guard unreachable or erroring: costly work is refused with 503 (section 4). A refusal never writes.
- D1 unreachable: the settings lookup keeps its last cached value, or the var. The breaker logs the failed write and retries next run; the latch holds.
- Analytics unreachable: counters still trip; one alert after 3 runs.
- Counters are exact for what the Worker does. Presigned R2 PUTs and floods that never reach a meter are seen only through analytics and the platform spend limits, which stay on.

## 7. The tables F adds

```sql
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
```

No seed rows: an absent row means the default in code, so a default cannot drift from the code. The breaker also writes an `admin_action` row per flip (`admin_user_id` `breaker`, action `switch_flip`, target kind `setting`).

## 8. Unverified

- The analytics dataset and field names in `src/worker/spend/analytics.ts` (Workers, Durable Objects, R2, D1) are written from memory of the schema and not yet read back with a live token. Each dataset is its own query, so a wrong name loses one reading and shows in the alert's sources.
- Container, Workflow and log-ingest datasets are not read; the container cap is counted in the guard.
- Email bounce spikes have no source yet.
- Whether auto-responded WebSocket pings bill as messages decides if the Durable Object spend limit is the only stop for a ping storm.
