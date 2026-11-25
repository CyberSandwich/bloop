# Spend guard

The owner doc for every switch, cap, breaker line and the review routine. Why a Durable Object and how to remove it: `docs/adr/0029-spend-guard.md`. The code is `src/worker/spend/`; nothing else restates these numbers.

Cloudflare's spend limits cover only Workers and Durable Objects, and the owner sets those in the dashboard. Containers, R2, D1, Workflows, Email and Logs have no platform ceiling, so bloop's own limits are the ceiling. The target is a monthly overage of about $10 across those. Four layers, each with one job:

- **Switches** turn a feature off in seconds with no deploy (section 1).
- **Caps** are exact counters and pools in one Durable Object, `SpendGuard`, that refuse work past a number (sections 2 to 4).
- **The breaker** runs every 5 minutes. It warns early, flips the matching switch when a daily trip line or the month's budget is crossed, and stays flipped until the owner resets it (sections 5 to 7).
- **The review routine** keeps the limits in step with the project's growth (section 9).

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

- **Flip now:** the `/admin` switch panel writes the row and logs `admin_action`. Effective within 30 seconds (the per-isolate cache).
- **Flip with D1 or `/admin` unreachable:** `wrangler deploy --var SWITCH_UPLOADS:off` from the owner's machine, then commit the same value to `wrangler.jsonc`. A var is a floor: a row can make it stricter, never looser. Remove the var to lift it.
- **Reset after a breaker trip:** `/admin` calls `resetBreaker` for one switch or `resetAllBreakers` for all. Each clears the latch in the SpendGuard, sets the row back to its default and logs it. Setting a row by hand does not release the latch: the next run puts the flip back.
- **Reset after the month's stop:** raise `BREAKER_BUDGET_MONTH_USD` by deploy first (or wait for the 1st), then reset. While the month is still over budget the next run trips again.
- **Stop the automatic flips:** set `breaker` to alert_only. Alerts continue; the breaker names what it would have flipped.

## 2. What the guard keeps

All counts are global, exact and per UTC period; a day's all-scopes total is kept 40 days. A meter with a per-scope limit also keeps its all-scopes count, which is what the breaker reads. A refused take adds nothing and writes nothing.

| meter | counts | limits (cap names in section 3) |
|---|---|---|
| `container_seconds` | stage-timeout seconds charged at container start, refunded on finish | day |
| `convert_user` | conversions per account | day, per user |
| `convert_guest` | guest conversions | day, per IP hash |
| `convert_demo` | demo conversions | day, and day per IP hash |
| `conversion_done`, `conversion_failed` | finished and failed conversions | none; the breaker reads them |
| `workflow_steps` | Workflow steps a conversion ran (about 15 each) | none; priced in section 6 |
| `r2_class_a`, `r2_class_b` | R2 operations | month |
| `upload_user`, `upload_user_bytes` | library uploads and bytes | day, per user |
| `guest_drop` | guest drops | day, per IP hash |
| `email` | sends | hour and day |
| `email_recipient` | sends per recipient hash | day, per recipient |
| `email_code` | sign-in code requests | day, per IP hash |
| `export_user` | exports | day, per user |
| `demo_session` | demo sessions | day |
| `d1_writes` | bloop's own D1 row writes | none; priced in section 6 |

Pools hold a lease that frees itself: `convert` (accounts), `convert_public` (guest and demo), `export`. A lease has a deadline (the requested time, at most the pool's maximum). The Converter destroys its container at the deadline. An unreleased lease keeps its slot through the grace, then is dropped and counted; the breaker turns `convert` off on any overdue or dropped lease, because a container may still be running.

## 3. Caps

Each cap has a default in `src/worker/spend/caps.ts` and a var that replaces it; the var is the maximum. A `cap.<name>` row from `/admin` can lower a cap and never raise it (`setOverrides`). A var that is not a number of at least 0 is ignored. None of these vars is in `wrangler.jsonc`; set one with `wrangler deploy --var`. A cap is a hard refusal; the trip lines in section 6 sit under the caps and act first.

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
| conversion | per request: `take("convert_user", 1, userId)`, `take("convert_guest", 1, ipHash)` or `take("convert_demo", 1, ipHash)`: 429. In the Workflow: `acquire("convert" or "convert_public", ttlSeconds, scope)`; busy means `step.sleep(retryAfterSeconds)` and try again, never a loop; `take("container_seconds", stageTimeoutSum)` before `start()` and `refund` of the unused part with the time of the take; a refusal marks the derived row failed once. `release(leaseId)` in `finally`. `record("workflow_steps", steps)` and `record("conversion_done" or "conversion_failed", 1)` |
| accounts | `take("email", 1)`, `take("email_recipient", 1, recipientHash)`, `take("email_code", 1, ipHash)` before a send: 429, and the code route says "Try Your Passkey or Ask for a Sign-In Link". Also the admin spend panel and routes (section 8) |
| library | `acquire("export", 900, userId)` and `take("export_user", 1, userId)` |
| present server | `take("demo_session", 1)` before a demo create |
| anything writing D1 on a hot path | `record("d1_writes", rows)` |

## 5. The breaker

`runSpendBreaker(env)` runs on the `*/5 * * * *` cron. It reads the guard's exact counters and, when `CF_ANALYTICS_TOKEN` and `CF_ACCOUNT_ID` are set, daily totals from the GraphQL Analytics API (Account Analytics Read only). With no token it uses counters alone and every alert says "counters only". Each run builds the spend report (section 8) and stores it. It then:

1. latches each trip in the guard, writes the switch row as actor `breaker` with an `admin_action` line, and sends one alert per trip, listing every switch the trip flipped (a failed write or alert is retried next run);
2. sends a warning at most once per rule per UTC day;
3. never loosens a switch; a stricter trip on the same switch is a new trip and a new alert;
4. sends one alert when analytics fails 3 runs in a row;
5. on Mondays, sends the digest (section 7), once per ISO week.

An alert holds numbers only: no file names, addresses or user data. Until email is wired the alert is a log line `{"evt":"breaker",...}`.

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
| live conversion leases | more than `BREAKER_LEASES_LIVE_MAX` | `convert=off` |
| a lease past its deadline, or dropped | any | `convert=off` |
| failed conversions | more than `BREAKER_CONVERT_FAILED_PCT` percent of at least `BREAKER_CONVERT_FAILED_MIN` | `convert=account_only` |
| Workers and Durable Object usage (analytics) | lines below | warning only |

| var | default | line |
|---|---|---|
| `BREAKER_TRIP_PCT` | 100 | percent of a daily cap that trips its switch |
| `BREAKER_WARN_PCT` | 50 | percent of a daily trip line or cap that warns |
| `BREAKER_MONTH_WARN_PCT` | 80 | percent of a monthly cap or of the budget that warns |
| `BREAKER_LEASES_LIVE_MAX` | 4 | live conversion leases that mean a leak |
| `BREAKER_CONVERT_FAILED_PCT` | 20 | failed conversions as a percent of the day's |
| `BREAKER_CONVERT_FAILED_MIN` | 10 | conversions needed before the percent counts |
| `BREAKER_GUEST_DROPS_DEMO_OFF_DAY` | 1,000 | guest drops in a day: demo drop off |
| `BREAKER_GUEST_DROPS_FILES_STOPPED_DAY` | 3,000 | guest drops in a day: guest files stopped |
| `BREAKER_WORKERS_REQ_DAY_WARN` | 1,000,000 | Worker requests in a day: warn |
| `BREAKER_WORKERS_SPIKE_MULTIPLE` | 3 | Worker requests over this multiple of the trailing 7-day mean: warn |
| `BREAKER_WORKERS_SPIKE_FLOOR` | 50,000 | a spike must also pass this many requests |
| `BREAKER_DO_REQ_DAY_WARN` | 150,000 | Durable Object requests in a day: warn |
| `BREAKER_DO_GBS_DAY_WARN` | 30,000 | Durable Object GB-seconds in a day: warn |
| `BREAKER_ANALYTICS_FAIL_RUNS` | 3 | consecutive runs with a failed analytics read before the alert |

The guest-drop lines are G's numbers, not from the cost plan.

## 6. The $10 month and the adaptive trip lines

**The budget.** `BREAKER_BUDGET_MONTH_USD` (default 10) is the estimated month-to-date cost of everything without a platform cap. It is split by share across the meters. Each meter's daily floor is its share of the budget over 30 days, in units: `floor = round(share x budget / 30 / unit price)`. Prices are the overage rates in the v4 cost plan, section 1 (kept outside the repo). Free allowances are not subtracted, so the estimate and the lines run high and trip early; the platform bills less than the estimate.

| meter | what | price | share (var) | $ a month | $ a day | floor a day | default ceiling a day | other vars | on trip |
|---|---|---|---|---|---|---|---|---|---|
| `container_seconds` | Containers, standard-2 at full CPU, an upper bound | $35.80 per million seconds | 40 (`BREAKER_SHARE_CONTAINERS`) | $4.00 | $0.133 | 3,724 s (1.03 h) | 18,620 | `BREAKER_FLOOR_CONTAINERS`, `BREAKER_CEILING_CONTAINERS` | `convert=account_only` |
| `r2_class_a` | R2 class A | $4.50 per million | 15 (`BREAKER_SHARE_R2_CLASS_A`) | $1.50 | $0.050 | 11,111 | 55,555 | `BREAKER_FLOOR_R2_CLASS_A`, `BREAKER_CEILING_R2_CLASS_A` | `uploads=readonly` |
| `r2_class_b` | R2 class B | $0.36 per million | 5 (`BREAKER_SHARE_R2_CLASS_B`) | $0.50 | $0.017 | 46,296 | 231,480 | `BREAKER_FLOOR_R2_CLASS_B`, `BREAKER_CEILING_R2_CLASS_B` | `previews=off` |
| `d1_writes` | D1 rows written | $1.00 per million | 10 (`BREAKER_SHARE_D1`) | $1.00 | $0.033 | 33,333 | 166,665 | `BREAKER_FLOOR_D1`, `BREAKER_CEILING_D1` | `demo=off` |
| `workflow_steps` | Workflow steps | $8.00 per million | 5 (`BREAKER_SHARE_WORKFLOWS`) | $0.50 | $0.017 | 2,083 | 10,415 | `BREAKER_FLOOR_WORKFLOWS`, `BREAKER_CEILING_WORKFLOWS` | `convert=account_only` |
| `email` | Email sends | $350.00 per million | 10 (`BREAKER_SHARE_EMAIL`) | $1.00 | $0.033 | 95 | 475 | `BREAKER_FLOOR_EMAIL`, `BREAKER_CEILING_EMAIL` | `email=admin_only` |

The other 15 percent: R2 storage 5 (`BREAKER_SHARE_R2_STORAGE`, $0.50, $0.015 per GB-month, so a warning at 33 GB) and logs 10 (`BREAKER_SHARE_LOGS`, $1.00, not measured yet). Storage and logs warn and never trip; storage counts in the month-to-date cost once analytics reads it.

| var | default | meaning |
|---|---|---|
| `BREAKER_BUDGET_MONTH_USD` | 10 | month-to-date cost at which the breaker flips every costly switch |
| `BREAKER_K` | 3 | a daily trip line follows this multiple of the trailing p95 |
| `BREAKER_HISTORY_DAYS` | 14 | completed days the p95 is taken over |
| `BREAKER_HISTORY_MIN_DAYS` | 7 | completed days needed before the p95 counts |
| `BREAKER_CEILING_MULTIPLE` | 5 | default ceiling as a multiple of the floor |
| `BREAKER_CEILING_WATCH_PCT` | 70 | percent of its ceiling a meter's wanted line may reach before the digest flags it |
| `BREAKER_SHARE_R2_STORAGE` | 5 | percent of the budget for R2 storage (warn only) |
| `BREAKER_SHARE_LOGS` | 10 | percent of the budget set aside for logs (no meter yet) |

**The line.** Each day, a meter's trip line is `clamp(max(floor, k x p95), floor, ceiling)`:

- `p95` is the nearest-rank 95th percentile of the meter's daily totals over the last `BREAKER_HISTORY_DAYS` completed UTC days, counting days with no usage as 0. Today is left out.
- With fewer than `BREAKER_HISTORY_MIN_DAYS` completed days of history (a new guard, or too little data), the line is the floor.
- The ceiling is the meter's `BREAKER_CEILING_<METER>` var, default `BREAKER_CEILING_MULTIPLE` times the floor, and never below the floor. The line never exceeds it. Only the owner raises it.
- The history is the guard's own daily totals, and, with analytics, the larger of the two for each day (presigned R2 PUTs never pass a meter). The guard keeps 40 days.
- One abuse day can lift the p95 to that day's level, so it can lift the line at most to the ceiling. That is why the ceiling is the owner's to raise.

Worked example, email: floor 95. After 14 days at 50 sends, p95 is 50, so the line is 150: a warning at 75 and a trip at 150. At 120 sends a day the want is 360, 76 percent of the 475 ceiling, so the digest suggests a higher ceiling.

**The warning.** At `BREAKER_WARN_PCT` (50) percent of the current line, one email, no trip, once a day per meter.

**The month-to-date stop.** The estimated month-to-date cost is each priced meter's month total times its price, plus R2 storage when analytics reads it. At the budget, one trip flips every costly switch and sends one alert listing them:

| switch | value | why |
|---|---|---|
| `convert` | off | containers and Workflow steps |
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
- On an event: any budget or spend-limit alert; any breaker trip; a meter at the watch percent of its ceiling; before switching `launch_mode` to open; before any invite batch over 20 people.

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
| 1,000 | about $62 | $74 / $99 / $124 / $186 | 100 | containers 300,000; R2 class A 1,000,000; R2 class B 670,000; D1 1,000,000; Workflow steps 50,000; email 1,700 with `CAP_EMAIL_DAY` 2,000 | $10 each, or the digest's suggestion once it differs |

## 10. Fails closed, and what stays open

- Guard unreachable or erroring: costly work is refused with 503 (section 4). A refusal never writes.
- D1 unreachable: the settings lookup keeps its last cached value, or the var. The breaker logs the failed write and retries next run; the latch holds.
- Analytics unreachable: counters still trip; one alert after 3 runs.
- Counters are exact for what the Worker does. Presigned R2 PUTs and floods that never reach a meter are seen only through analytics and the platform spend limits, which stay on.

## 11. The tables F adds

```sql
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
```

No seed rows: an absent row means the default in code, so a default cannot drift from the code. The breaker also writes an `admin_action` row per flip (`admin_user_id` `breaker`, action `switch_flip`, target kind `setting`).

## 12. Unverified

- The analytics dataset and field names in `src/worker/spend/analytics.ts` (Workers, Durable Objects, R2, D1) are written from memory of the schema and not yet read back with a live token. Each dataset is its own query, so a wrong name loses one series and shows in the alert's sources.
- Log ingest and the Containers and Workflows datasets are not read; containers and Workflow steps are counted in the guard, and the share set aside for logs is not enforced.
- Email bounce spikes have no source yet.
- Whether auto-responded WebSocket pings bill as messages decides if the Durable Object spend limit is the only stop for a ping storm.
- The growth table's average days are derived from the cost plan's per-user model; replace them with the measured numbers after the first month.
