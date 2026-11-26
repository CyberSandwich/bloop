# Spend guard

The owner doc for every switch, cap, breaker line and the review routine. Why a Durable Object and how to remove it: `docs/adr/0029-spend-guard.md`. The code is `src/worker/spend/`; nothing else restates these numbers.

Cloudflare's spend limits cover only Workers and Durable Objects, and the owner sets those in the dashboard. Containers, R2, D1, Email and Logs have no platform ceiling, so bloop's own limits are the ceiling. The target is a monthly overage of about $10 across those. Four layers, each with one job:

- **Switches** turn a feature off in seconds with no deploy (section 1).
- **Caps** are exact counters and pools in one Durable Object, `SpendGuard`, that refuse work past a number (sections 2 to 4).
- **The breaker** runs every 5 minutes. It warns early, flips the matching switch when a daily trip line or the month's budget is crossed, and stays flipped until the owner resets it (sections 5 to 7).
- **The review routine** keeps the limits in step with the project's growth (section 9).

## 1. Switches

A switch is a D1 `setting` row (key, value). The value in force is the more restrictive of the Worker var and the row, so the var is a floor a deploy can set. With no row, the default applies. A value a switch does not allow, in the row or the var, counts as the most restrictive. Allowed values run from least to most restrictive; `src/worker/spend/switches.ts` is the registry and `effectiveSwitch` is the merge.

There is one reader of the `setting` table, F's settings reader (one query, one 30 second cache, the last good value for at most 5 minutes after an error, then each key's most restrictive value). Its snapshot is a plain key to value record (`SettingsSnapshot`); `effectiveAll(vars, snapshot)` and `capOverridesOf(snapshot)` are pure functions of it, and nothing in the guard reads D1 for a switch on a request path. The launch mode is not a spend switch: it is F's setting (ADR 0026), has no var, and is not in this registry. These fourteen switches are the whole registry.

| switch | var | values | default | stops |
|---|---|---|---|---|
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

- **Flip now:** the `/admin` switch panel writes the row and logs `admin_action`. Effective within 30 seconds (the per-isolate cache).
- **Flip with D1 or `/admin` unreachable:** `wrangler deploy --var SWITCH_UPLOADS:off` from the owner's machine, then commit the same value to `wrangler.jsonc`. A var is a floor: a row can make it stricter, never looser. Remove the var to lift it.
- **Reset after a breaker trip:** `/admin` calls `resetBreaker` for one switch or `resetAllBreakers` for all. Each puts the row back to its value from before the first trip (the default when there was no row), then clears the latch in the SpendGuard, and logs it. It restores only a row the breaker wrote (the value is the trip's and `updated_by` is `breaker`): a row someone set since stands, even to the same value, and a reset never loosens past it. When the row could not be read at the trip (D1 down), the prior is recorded as unknown and a reset leaves the row as it is, for the owner to set. Both calls take no auth of their own, so A's route must check an admin session first. Setting a row by hand does not release the latch: the next run puts the flip back when the value in force is looser than the trip.
- **Reset after the month's stop:** raise `BREAKER_BUDGET_MONTH_USD` by deploy first (or wait for the 1st), then reset. While the month is still over budget the next run trips again.
- **Stop the automatic flips:** set `breaker` to alert_only. Alerts continue; the breaker names what it would have flipped.

## 2. What the guard keeps

All counts are global, exact and per UTC period; a day's all-scopes total is kept 40 days. A meter with a per-scope limit also keeps its all-scopes count, which is what the breaker reads. A refused take adds nothing and writes nothing. The guard is two instances of one class: `global` holds every costly meter, the pools and the breaker's state; `public` holds only `demo_session`, `email` and `email_code`, the meters that fail open. A flood of public calls can overload `public` and no more: uploads, conversion and export never wait on it. The breaker reads those three meters (and email's history) from `public`.

| meter | counts | limits (cap names in section 3) |
|---|---|---|
| `container_seconds` | stage-timeout seconds charged at container start, refunded on finish | day |
| `convert_user` | conversions per account | day, per user |
| `convert_guest` | guest conversions | day, per IP hash |
| `convert_demo` | demo conversions | day, and day per IP hash |
| `conversion_done`, `conversion_failed` | finished and failed conversions | none; the breaker reads them |
| `r2_class_a`, `r2_class_b` | R2 operations, charged once per request in reserved blocks (`charge`, section 4) | month |
| `upload_user`, `upload_user_bytes` | library uploads and bytes | day, per user |
| `guest_drop` | guest drops | day, per IP hash |
| `email` | sends | hour and day |
| `email_code` | sign-in code requests | day, per IP hash |
| `export_user` | exports | day, per user |
| `demo_session` | demo sessions | day |
| `d1_writes` | D1 rows written, read from analytics only: no caller records it | none; priced in section 6 |

Pools hold a lease that frees itself: `convert` (accounts), `convert_public` (guest and demo), `export`. A lease has a deadline (the requested time, at most the pool's maximum). The Converter destroys its container at the deadline. An unreleased lease keeps its slot through the grace (a release is usually in flight), then is dropped and counted; the breaker turns `convert` off on any lease dropped past deadline plus grace, because a container may still be running. A reset of `convert` takes the day's dropped leases as seen, so only a lease dropped after it trips again. A pool with a per-scope cap (`export`) needs a scope.

## 3. Caps

Each cap has a default in `src/worker/spend/caps.ts` and a var that replaces it; the var is the maximum. A `cap.<name>` row from `/admin` can lower any cap and never raise it: the breaker pushes the rows to both guard instances (`setOverrides`), and the composition root passes the same rows to `spendFor(env, overrides)` for the caps the client keeps (the R2 block and the isolate allowances). A var that is not a number of at least 0 is ignored. None of these vars is in `wrangler.jsonc`; set one with `wrangler deploy --var`. A cap is a hard refusal; the trip lines in section 6 sit under the caps and act first.

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
| `CAP_EMAIL_DAY` | 180 | sends per day account-wide; platform quota 200/day until raised; raise this cap only after Cloudflare raises the quota |
| `CAP_EMAIL_CODE_IP_DAY` | 20 | sign-in code requests per IP hash per day |
| `CAP_EXPORT_USER_DAY` | 3 | exports per account per day |
| `CAP_DEMO_SESSION_DAY` | 2000 | demo sessions per day, all visitors |
| `CAP_R2_BLOCK_OPS` | 100 | R2 operations of one class an isolate reserves from the guard at a time and spends locally (section 4) |
| `CAP_ISOLATE_OPEN_EMAIL_DAY` | 20 | sends per day one Worker isolate allows while the guard is unreachable (section 4) |
| `CAP_ISOLATE_OPEN_EMAIL_CODE_IP_DAY` | 10 | code requests per IP hash per day one isolate allows while the guard is unreachable |
| `CAP_ISOLATE_OPEN_DEMO_SESSION_DAY` | 200 | demo sessions per day one isolate allows while the guard is unreachable |

## 4. What a caller does on refusal

The composition root builds one `Spend` with `spendFor(env)` (`src/worker/spend/guard.ts`) and passes it through each route's and Durable Object's deps; nothing else calls `spendFor`. `Spend` (`src/worker/spend/client.ts`) is an interface, so unit tests of U, V2 and A pass a fake and never start the guard. Presenting an already-converted file never calls it. `refusal(result)` returns the response to send.

**A caller bug throws; only a transport error is an outage.** `take`, `charge`, `acquire`, `record` and `refund` check their arguments before any RPC: `n` is a positive integer (a byte meter needs at least 1), a scoped meter and a pool with a per-scope cap need a scope, a ttl is above 0. A bad call throws a `RangeError` and is never admitted as a fail-open outage. On an unauthenticated route, the route's own rate-limit binding (`RL_*`) passes first, then the guard is called.

**When the guard cannot be reached**, each call has a fixed mode, tested per meter:

| path | calls | guard unreachable |
|---|---|---|
| container | `acquire("convert" or "convert_public")`, `take("container_seconds")`, the per-scope conversion takes | refused (`unavailable`, 503) |
| part mint | `charge("A", n)` | refused |
| upload | `take("upload_user")`, `take("upload_user_bytes")`, `take("guest_drop")`, `charge("B", n)` for the validation reads | refused |
| export | `acquire("export")`, `take("export_user")` | refused |
| demo | `take("demo_session")` | admitted up to `CAP_ISOLATE_OPEN_DEMO_SESSION_DAY` a day in that isolate, then 429 |
| email | `take("email")` | admitted up to `CAP_ISOLATE_OPEN_EMAIL_DAY` a day in that isolate, then 429 |
| sign-in code | `take("email_code", 1, ipHash)` | admitted up to `CAP_ISOLATE_OPEN_EMAIL_CODE_IP_DAY` a day per IP hash in that isolate, then 429 |

A guard outage must not end code sign-in or the public demo, and email is capped at 200 a day by the platform anyway. The three public meters live on the `public` instance, so an outage or flood there fails only them open, and never makes a costly path answer 503. The isolate count lives in the isolate (all clients in it share one) and starts again each UTC day; the breaker's lines and the platform quota bound the rest. Every fail-open admission logs `spend_guard_open`.

**`charge` is block-reserved.** A Worker request is not one guard call per R2 operation: each isolate reserves `CAP_R2_BLOCK_OPS` (100) operations of a class from the guard, spends them locally, and never returns the leftover, so 250 single charges make 3 guard writes. The guard's monthly count is therefore the reserved total, never lower than the spent total; at most one block per isolate per class is counted but not yet used. Where a whole block no longer fits under the cap, the client takes exactly what it is short by, so the cap still refuses at the exact operation. A charge that cannot be covered is refused with 429 (cap) or 503 (guard unreachable); the reserve is held during the call and given back if the charge is refused or lost, so reserved operations keep being spent while the guard is down. The reserve is stamped with the UTC month and dropped when the month changes, so a new month is charged from the guard (at most a block per isolate stays counted in the earlier month).

| result | status | code | header |
|---|---|---|---|
| `cap_hit` | 429 | `rate_limited` | `Retry-After` seconds to the end of the period |
| `busy` | 503 | `service_busy` | `Retry-After`, at most 60 |
| `unavailable` | 503 | `service_busy` | `Retry-After` 30 |

Calls, by stream. A caller checks its switch first and calls the guard second. A `refund` is for work that never started. Only `container_seconds`, `upload_user` and `upload_user_bytes` are refunded, so only a take of those returns a ticket (`id`, `meter`, `n`); refunding any other take does not compile. The guard mints the id (random, 96 bits) and records the meter, scope, amount and time against it, so a refund cannot name another scope, pick a day or exceed the take (the client throws on a larger `n`). It does nothing for an unknown or already used id, or one older than the longest lease plus its grace, and never takes a counter below zero. On a scoped meter it lowers the all-scopes count by at most what that scope's own count holds, so one caller cannot erase another's. Each id is honored once, so a partial refund is the ticket's only one. The guard keeps a take record for that window plus a day, computed from the lease vars (their defaults stay within 6 hours, the container's inactivity limit).

| stream | calls |
|---|---|
| uploads | `take("upload_user", 1, userId)` and `take("upload_user_bytes", bytes, userId)` at create; `take("guest_drop", 1, ipHash)` per guest drop; `charge("A", n)` once per part-URL mint request; `charge("B", n)` once per validation, where `n` is the reads that validation makes (2 for a small deck, at most 64 for a large one) |
| conversion | per request: `take("convert_user", 1, userId)`, `take("convert_guest", 1, ipHash)` or `take("convert_demo", 1, ipHash)`: 429. In the Converter: `acquire("convert" or "convert_public", ttlSeconds, scope)`; busy means set the alarm for `retryAfterSeconds` and try again, never a loop; `take("container_seconds", stageTimeoutSum)` before `start()` and `refund(ticket, unused)` of the unused part; a refusal marks the derived row failed once. `release(leaseId)` in `finally` (idempotent, retried once by the client). `record("conversion_done" or "conversion_failed", 1)` |
| accounts | `take("email", 1)` and `take("email_code", 1, ipHash)` before a send: 429, and the code route says "Try Your Passkey or Ask for a Sign-In Link". The per-recipient limit is A's `email_code` buckets, not a guard meter. Also the admin spend panel and routes (section 8) |
| library | `acquire("export", 900, userId)` and `take("export_user", 1, userId)` |
| present server | `take("demo_session", 1)` before a demo create |

## 5. The breaker

`runSpendBreaker(env)` runs on the `*/5 * * * *` cron. It reads the guard's exact counters and, when `CF_ANALYTICS_TOKEN` and `CF_ACCOUNT_ID` are set, daily totals from the GraphQL Analytics API (Account Analytics Read only). With no token it uses counters alone and every alert says "counters only". Each run builds the spend report (section 8) and stores it. It then:

1. latches each trip in the guard (with the row's value from before, so a reset can restore it), writes the switch row as actor `breaker` with an `admin_action` line, and sends one alert per trip, listing every switch the trip flipped (a failed write or alert is retried next run; overlapping runs claim the alert in the guard, so one is sent). While the row cannot be written (D1 down) the alert is still sent, marked not applied, since that is when the owner sets the floor with `wrangler deploy --var`; the trip is marked alerted, and announced as applied, only once the row is written. A reset that lands between the run's read and its write is not undone: the run checks the latch again just before it writes;
2. sends a warning at most once per rule per UTC day; every send is in a try, and a failed one releases its claim so the next run retries, and never stops the trips;
3. never loosens a switch: it writes only when the value in force (the stricter of the Worker var and the row, an unknown row value counting as the strictest) is looser than the trip, and every trip is stricter than its switch's default; a stricter trip on the same switch is a new trip and a new alert;
4. sends one alert, at most once a UTC day, while analytics has failed 3 or more runs in a row; a dataset that fails keeps its last good figures (the report takes the larger of those and the counters) and the report's sources say so;
5. on Mondays, sends the digest (section 7), once per ISO week.

An alert holds numbers only: no file names, addresses or user data. The alert is a log line `{"evt":"breaker",...}`, written once a day per alert key (so two config problems, or an unapplied trip and its applied retry, are two alerts), plus an email to each `ADMIN_EMAILS` address (ADR 0021), tried at most 6 times a day per key (a reset releases a trip's claims, so a re-trip that day logs and mails again); an owner-set `email=off` silences the breaker's mail too, leaving the log line. With mail on, no alert depends on a log rule or an observability query, which head sampling would starve.

Email bounces come from the GraphQL dataset `emailSendingAdaptive` (`deliveryFailed`); the breaker does not read it yet. Messages on open WebSockets are not stopped by the Durable Object spend limit, so P1's socket caps are the bound, and the breaker's Durable Object request line (`BREAKER_DO_REQ_DAY_WARN`) warns on growth.

| rule | line | acts |
|---|---|---|
| a priced meter's day reaches its trip line (section 6) | the line | its switch, as listed in section 6 |
| the same, past the warn line | `BREAKER_WARN_PCT` percent of the line | warning |
| month-to-date cost reaches the budget | `BREAKER_BUDGET_MONTH_USD` | every costly switch (section 6) |
| month-to-date cost past the warn line | `BREAKER_MONTH_WARN_PCT` percent of the budget | warning |
| R2 storage past its share of the budget | section 6 | warning |
| demo conversions or demo sessions reach their daily cap | `BREAKER_TRIP_PCT` percent of the cap | `demo_drop=off`, `demo=off` |
| R2 class A or B in a month | `BREAKER_MONTH_WARN_PCT` percent of the cap | warning |
| guest drops in a day | two lines below | `demo_drop=off`, then `guest_files=stopped` |
| live conversion leases | more than the two conversion pools allow together (`CAP_POOL_CONVERT` plus `CAP_POOL_CONVERT_PUBLIC` as the vars set them: lowering a pool with a row never reads as a leak) | `convert=off` |
| a lease dropped past its deadline plus grace | any | `convert=off` |
| failed conversions | more than `BREAKER_CONVERT_FAILED_PCT` percent of at least `BREAKER_CONVERT_FAILED_MIN` | `convert=off` |
| Workers and Durable Object usage (analytics) | lines below | warning only |

| var | default | line |
|---|---|---|
| `BREAKER_TRIP_PCT` | 100 | percent of a daily cap that trips its switch |
| `BREAKER_WARN_PCT` | 50 | percent of a daily trip line or cap that warns |
| `BREAKER_MONTH_WARN_PCT` | 80 | percent of a monthly cap or of the budget that warns |
| `BREAKER_CONVERT_FAILED_PCT` | 20 | failed conversions as a percent of the day's |
| `BREAKER_CONVERT_FAILED_MIN` | 10 | conversions needed before the percent counts |
| `BREAKER_GUEST_DROP_COST_USD` | 0.00002 | cost of one guest drop |
| `BREAKER_GUEST_DROPS_DEMO_OFF_PCT` | 5 | percent of the budget a day's guest drops may cost: demo drop off |
| `BREAKER_GUEST_DROPS_FILES_STOPPED_PCT` | 15 | percent of the budget a day's guest drops may cost: guest files stopped |
| `BREAKER_WORKERS_REQ_DAY_WARN` | 1,000,000 | Worker requests in a day: warn |
| `BREAKER_WORKERS_SPIKE_MULTIPLE` | 3 | Worker requests over this multiple of the trailing 7-day mean: warn |
| `BREAKER_WORKERS_SPIKE_FLOOR` | 50,000 | a spike must also pass this many requests |
| `BREAKER_DO_REQ_DAY_WARN` | 150,000 | Durable Object requests in a day: warn |
| `BREAKER_DO_GBS_DAY_WARN` | 30,000 | Durable Object GB-seconds in a day: warn |
| `BREAKER_ANALYTICS_FAIL_RUNS` | 3 | consecutive runs with a failed analytics read before the alert |

The guest-drop lines are shares of the budget. One drop that is not converted costs 3 R2 class A ($0.0000135), 3 class B ($0.0000011) and 5 D1 rows ($0.000005), $0.0000194, rounded up to `BREAKER_GUEST_DROP_COST_USD`. A line is `round(pct / 100 x budget / 30 / cost)` drops a day: 5 percent is 833 and 15 percent is 2,500 at the defaults. These lines overlap the R2 and D1 meter shares in section 6 (the same operations count in both), so either can trip first.

## 6. The $10 month and the adaptive trip lines

**The budget.** `BREAKER_BUDGET_MONTH_USD` (default 10) is the estimated month-to-date cost of everything without a platform cap. It is split by share across the meters. Each meter's daily floor is its share of the budget over 30 days, in units: `floor = round(share x budget / 30 / unit price)`. Prices are the overage rates in the v4 cost plan, section 1 (kept outside the repo). Free allowances are not subtracted, so the estimate and the lines run high and trip early; the platform bills less than the estimate.

| meter | what | price | share (var) | $ a month | $ a day | floor a day | default ceiling a day | other vars | on trip |
|---|---|---|---|---|---|---|---|---|---|
| `container_seconds` | Containers, standard-2 at full CPU, an upper bound | $35.80 per million seconds | 45 (`BREAKER_SHARE_CONTAINERS`) | $4.50 | $0.150 | 4,190 s (1.16 h) | 20,950 | `BREAKER_FLOOR_CONTAINERS`, `BREAKER_CEILING_CONTAINERS` | `convert=off` |
| `r2_class_a` | R2 class A | $4.50 per million | 15 (`BREAKER_SHARE_R2_CLASS_A`) | $1.50 | $0.050 | 11,111 | 55,555 | `BREAKER_FLOOR_R2_CLASS_A`, `BREAKER_CEILING_R2_CLASS_A` | `uploads=readonly` |
| `r2_class_b` | R2 class B | $0.36 per million | 5 (`BREAKER_SHARE_R2_CLASS_B`) | $0.50 | $0.017 | 46,296 | 231,480 | `BREAKER_FLOOR_R2_CLASS_B`, `BREAKER_CEILING_R2_CLASS_B` | `previews=off` |
| `d1_writes` | D1 rows written | $1.00 per million | 10 (`BREAKER_SHARE_D1`) | $1.00 | $0.033 | 33,333 | 166,665 | `BREAKER_FLOOR_D1`, `BREAKER_CEILING_D1` | `demo=off` |
| `email` | Email sends | $350.00 per million | 10 (`BREAKER_SHARE_EMAIL`) | $1.00 | $0.033 | 95 | 180 | `BREAKER_FLOOR_EMAIL`, `BREAKER_CEILING_EMAIL` | `email=admin_only` |

The other 15 percent: R2 storage 5 (`BREAKER_SHARE_R2_STORAGE`, $0.50, $0.015 per GB-month, so a warning at 33 GB) and logs 10 (`BREAKER_SHARE_LOGS`, $1.00, not measured yet). Storage and logs warn and never trip; storage counts in the month-to-date cost once analytics reads it.

| var | default | meaning |
|---|---|---|
| `BREAKER_BUDGET_MONTH_USD` | 10 | month-to-date cost at which the breaker flips every costly switch |
| `BREAKER_K` | 3 | a daily trip line follows this multiple of the trailing p95 |
| `BREAKER_HISTORY_DAYS` | 14 | completed days the p95 is taken over |
| `BREAKER_HISTORY_MIN_DAYS` | 7 | completed days needed before the p95 counts |
| `BREAKER_CEILING_MULTIPLE` | 5 | default ceiling as a multiple of the floor |
| `BREAKER_LINE_GROWTH_MULTIPLE` | 2 | a line rises at most this multiple of the day before's line |
| `BREAKER_CEILING_WATCH_PCT` | 70 | percent of its ceiling a meter's wanted line may reach before the digest flags it |
| `BREAKER_SHARE_R2_STORAGE` | 5 | percent of the budget for R2 storage (warn only) |
| `BREAKER_SHARE_LOGS` | 10 | percent of the budget set aside for logs (no meter yet) |

**The line.** Each day, a meter's trip line is `clamp(max(floor, k x p95), floor, ceiling)`:

- `p95` is the nearest-rank 95th percentile of the meter's daily totals over the last `BREAKER_HISTORY_DAYS` completed UTC days, counting days with no usage as 0. Today is left out.
- With fewer than `BREAKER_HISTORY_MIN_DAYS` completed days of history (a new guard, or too little data), the line is the floor.
- The ceiling is the meter's `BREAKER_CEILING_<METER>` var, default `BREAKER_CEILING_MULTIPLE` times the floor, and never below the floor. Email's default is held to `CAP_EMAIL_DAY` (180 here, under 5 times 95), so its adaptive line and its hard cap cannot disagree; raise both together, and the cap only after Cloudflare raises its 200 a day email quota. The line never exceeds the ceiling. Only the owner raises it.
- The history is the guard's own daily totals, and, with analytics, the larger of the two for each day (presigned R2 PUTs never pass a meter). The guard keeps 40 days.
- A line rises at most `BREAKER_LINE_GROWTH_MULTIPLE` (2) times the line of the day before, never under the floor: each day's line is worked out from the days before it, oldest first, so one abuse day lifts it one step a day, and the ceiling still caps it. That is why the ceiling is the owner's to raise.
- `BREAKER_BUDGET_MONTH_USD`, `BREAKER_GUEST_DROP_COST_USD`, `BREAKER_LINE_GROWTH_MULTIPLE`, every share, and every floor and ceiling var must be above 0: a value that is not is logged once and the default is used. A line that still computes to zero or not a number (a budget so small a floor rounds to 0) trips its switch at once; it is never skipped.

Worked example, email: floor 95. After 14 days at 40 sends, p95 is 40, so the line is 120: a warning at 60 and a trip at 120. At 50 sends a day the want is 150, 83 percent of the 180 ceiling, so the digest suggests a higher ceiling.

**The warning.** At `BREAKER_WARN_PCT` (50) percent of the current line, one email, no trip, once a day per meter.

**The month-to-date stop.** The estimated month-to-date cost is each priced meter's month total times its price, plus R2 storage when analytics reads it. At the budget, one trip flips every costly switch and sends one alert listing them:

| switch | value | why |
|---|---|---|
| `convert` | off | the containers line, failed conversions, overdue leases |
| `uploads` | readonly | R2 writes; files stay downloadable |
| `demo_drop` | off | the public's conversion path |
| `guest_drop` | off | live-room guest uploads |
| `email` | admin_only | sends; `/admin` invites still work |
| `export` | off | Worker CPU and R2 reads |
| `previews` | off | R2 reads |

They stay until reset in `/admin` (section 1).

## 7. The weekly digest

Every Monday (UTC) the first breaker run after midnight sends one email, subject `bloop spend digest <ISO week>`; a failed send is retried on the next run. For each priced meter: 7-day usage, the current trip line, the floor and ceiling, history days, and the month's cost. Then month-to-date against the budget with the month's projection, R2 storage, anything not measured, latched trips, and the Workers and Durable Objects month-to-date, projection and a suggested platform spend limit (about twice the projection, in steps of $5, never under $10; only when analytics is connected).

When a meter's wanted line (`k x p95`) reaches `BREAKER_CEILING_WATCH_PCT` percent of its ceiling, the digest names it, suggests doubling the ceiling var, and reminds the owner to move the platform limits and budget alerts in step. This fires before the line binds, which happens at a third of the ceiling when k is 3, so a meter that merely has a high p95 is flagged early on purpose.

The digest ends with the next monthly review date (the first Monday of the month, section 9) and the link to `/admin`.

## 8. The report, the panel and the route

One builder, `buildReport` in `src/worker/spend/report.ts`, feeds the breaker's rules, the `/admin` spend panel, the admin-only JSON route and the digest, so they cannot disagree. The breaker stores the latest report (at most 5 minutes old); `spendReportFor(env)` returns it, or null before the first run.

- **Route (A mounts it):** `GET /api/admin/spend`, admin session only, returns the report as JSON, `Cache-Control: no-store`. A future scheduled agent reads this.
- **Panel (A builds it in `/admin`):** per meter, today, 7 days, 30 days, month to date, month-to-date cost, the trip line, floor, ceiling and the `ceilingVar` to change; the budget bar (`monthToDateUsd`, `projectedUsd`, `budgetUsd`); the latched trips with reset buttons (`resetBreaker`, `resetAllBreakers`); the platform suggestion; the next review date.
- **Fields:** `at`, `month`, `budgetUsd`, `monthToDateUsd`, `projectedUsd`, `percentOfBudget`, `meters[]` (`meter`, `label`, `unit`, `today`, `last7`, `last30`, `monthToDate`, `monthToDateUsd`, `p95`, `historyDays`, `floor`, `ceiling`, `tripLine`, `warnLine`, `wantPctOfCeiling`, `nearCeiling`, `suggestedCeiling`, `ceilingVar`), `gauges[]`, `platform`, `trips[]`, `unmeasured[]`, `sources`, `nextReview`, `adminUrl`.

## 9. Review and adjust

**Where to look**

- The `/admin` spend panel: every number in section 8, live to 5 minutes.
- The Monday digest email: the same numbers plus growth flags and a suggested ceiling and platform limit.
- Cloudflare dashboard, Billing, Billable usage (the real bill) and Spend limits (Workers and Durable Objects, set separately).
- The breaker's alerts, and `/api/admin/spend` for an agent.

**Cadence**

- Weekly: read the Monday digest. Nothing to do unless it flags a meter or a trip.
- Monthly, first Monday: compare month-to-date and projected against the budget ladder below and against the real bill in Billable usage; check the Workers and Durable Objects platform limits ($10 each to start); raise a ceiling only with the digest's suggestion and a reason.
- On an event: any budget or spend-limit alert; any breaker trip; a meter at the watch percent of its ceiling; before the launch mode is set to open (F's setting); before any invite batch over 20 people.

**How to adjust**

| to change | set | in step |
|---|---|---|
| a meter's ceiling | its `BREAKER_CEILING_<METER>` var (section 6) | the budget, so the month's stop is not tighter than the ceilings allow |
| a meter's floor | its `BREAKER_FLOOR_<METER>` var, or the share var | |
| the month's stop | `BREAKER_BUDGET_MONTH_USD` | the budget ladder |
| a hard cap | its `CAP_` var (section 3), or lower it in `/admin` | `CAP_EMAIL_DAY` above the email ceiling, or the cap binds first |

Rules for the Cloudflare side:

- Platform spend limit for Workers, and for Durable Objects: about twice the expected month's cost of that product, never under the $10 the dashboard starts at. Read the expected cost from the digest's Workers and Durable Objects projection.
- Budget alerts (Billing, notifications): 1.2x, 1.6x, 2x and 3x the expected monthly total, base plan included. At the start: $6, $8, $10, $15.

**Growth table.** Expected cost from the v4 cost plan, section 1 (kept outside the repo). An average day is the month's usage over 30. The recommended ceiling is 10 times the average day, because p95 runs near twice the average and k is 3; below the default ceiling, leave the default. The budget var is about 1.5 times the gross month the plan implies, which is higher than the platform's overage because free allowances are not subtracted here.

| active users | expected bill (base plus overage) | budget ladder | `BREAKER_BUDGET_MONTH_USD` | ceilings to set | Workers and DO platform limits |
|---|---|---|---|---|---|
| 10 | about $5 | $6 / $8 / $10 / $15 | 10 | defaults hold | $10 each |
| 100 | about $9 | $11 / $14 / $18 / $27 | 10 | containers 30,000; R2 class A 100,000; the rest default | $10 each |
| 1,000 | about $62 | $74 / $99 / $124 / $186 | 100 | containers 300,000; R2 class A 1,000,000; R2 class B 670,000; D1 1,000,000; email 1,700 with `CAP_EMAIL_DAY` 2,000, after Cloudflare raises its email quota | $10 each, or the digest's suggestion once it differs |

## 10. Fails closed, and what stays open

- Guard unreachable or erroring: costly work is refused with 503 (section 4). A refusal never writes.
- D1 unreachable: the settings lookup keeps its last cached value, or the var. The breaker logs the failed write, sends the trip alert marked not applied, and retries next run; the latch holds.
- The `public` instance unreachable: the three public meters fail open per isolate, and the breaker skips the rules of those three meters rather than reading them as zero, marks the report and the digest "public guard unreadable", and sends one `public_unreadable` alert a day saying so.
- Analytics unreachable: counters still trip; one alert after 3 runs.
- An invalid Worker config (a mistyped var): the site answers 503, but the `*/5` cron still runs the breaker, with the vars the registry can read and its defaults for the rest. It sends one `config_invalid` alert a day per set of invalid vars, naming the vars and never their values. The hourly and daily jobs do not run.
- A Workers or Durable Object spend block stops crons account-wide (the breaker and the probe) and makes the guard unreachable. Cloudflare's $2 and $5 alert emails are then the only signal. The Converter reads `convert` from F's D1 settings before it starts, so a tripped `convert` holds without the guard.
- Counters are exact for what the Worker does. Presigned R2 PUTs and floods that never reach a meter are seen only through analytics and the platform spend limits, which stay on.

## 11. The tables F adds

F adds nothing for the guard beyond the `setting` and `admin_action` tables, both defined by the accounts migration (0005, ADR 0013). The guard reads and writes `setting(key, value, updated_at, updated_by)` and does not create it; `updated_by` is nullable and the breaker writes `breaker`. No seed rows: an absent row means the default in code, so a default cannot drift from the code. The breaker also writes an `admin_action` row per flip (`admin_user_id` `breaker`, action `switch_flip`, target kind `setting`).

## 12. Unverified

- The analytics dataset and field names in `src/worker/spend/analytics.ts` (Workers, Durable Objects, R2, D1) are written from memory of the schema and not yet read back with a live token. Each dataset is its own query, so a wrong name loses one series and shows in the alert's sources.
- Log ingest and the Containers dataset are not read; container seconds are counted in the guard, and the share set aside for logs is not enforced. D1 rows written and R2 operations beyond the monthly charge are read from analytics only: without `CF_ANALYTICS_TOKEN` the D1 line cannot trip.
- Whether auto-responded WebSocket pings bill as messages decides how large a ping storm can grow before the Durable Object request warning (spike G-3).
- The growth table's average days are derived from the cost plan's per-user model; replace them with the measured numbers after the first month.

## 13. Threat ids

A test id `COST-nn` is the cost plan's scenario `Wnn` (section 2 of the v4 cost plan, kept outside the repo). The guard owns the ones marked with tests; the rest are bounded elsewhere or seen only through analytics and the platform spend limits.

| id | cost-plan scenario | guard's part | tests cite it |
|---|---|---|---|
| COST-01 | W1 conversion flood from public guest drops | pools of 3 and 1, fail closed, exact under concurrency | yes |
| COST-02 | W2 containers that never stop | lease deadline and grace, overdue trips `convert=off` | yes |
| COST-03 | W3 conversion retry loops | failed-conversion trip, the container-seconds line | yes |
| COST-04 | W4 request flood on workers.dev | analytics warning only | no |
| COST-05 | W5 request flood on the zone | analytics warning only | no |
| COST-06 | W6 client polling loop | analytics warning only | no |
| COST-07 | W7 leaked presigned URL | R2 class A and B monthly caps and daily trip lines | yes |
| COST-08 | W8 WebSocket ping storm | Durable Object request-growth warning; P1's socket caps are the bound, since the platform limit does not stop socket messages | no |
| COST-09 | W9 non-hibernating objects | Durable Object GB-second warning, platform limit | no |
| COST-10 | W10 D1 write amplification | D1 rows-written meter and trip line | yes |
| COST-11 | W11 upload floods | per-user count and byte caps, guest drops per IP | yes |
| COST-12 | W12 zip and slide bombs | bounded by the same pools (the concurrency tests) | yes |
| COST-13 | W13 export of a large library | 3 a day per user, pool 4 and 1 per user | yes |
| COST-14 | W14 email abuse | hourly, daily and per-recipient caps, budget trip lines | yes |
| COST-15 | W15 log ingest blowup | share set aside, not measured | no |
| COST-16 | W16 bots on the demo | demo caps and trips, latched breaker | yes |
| COST-17 | W17 CPU bombs in the Worker | not a guard concern (CPU limit) | no |
