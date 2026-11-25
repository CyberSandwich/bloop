# ADR 0029: spend guard

Status: accepted

## Context
Cloudflare's hard spend limits cover only Workers and Durable Objects. Containers, R2, D1, Email and Logs have no platform ceiling, and a conversion container costs real money every second it is up. The public can start work: anyone can open a live screen or the demo and drop a file. The rate-limit bindings are per location, approximate and eventually consistent, so they bound one client but cannot give an exact global count. A bug, a loop or a flood must not produce a surprise bill or exhaust a resource.

## Decision
- **One class, two instances of `SpendGuard`** (SQLite, eu). `global` holds the costly meters, the pools and the breaker's state; `public` holds only the three fail-open meters, so a flood of public calls cannot make uploads, conversion or export answer 503. The main one also holds exact counters per meter per UTC hour, day and month, leases for long jobs, and the breaker's latched state. Its methods are synchronous, so the runtime never interleaves two callers between a check and the write it allows: a cap is exact under any concurrency. A refused take writes nothing.
- **Fail closed for cost, open for the public paths.** Callers hold a `Spend` interface (injected through route deps; `SpendClient` is the real one). An unreachable or throwing guard becomes a refusal (503) for containers, part mints, uploads, R2 charges and exports. The demo, email and sign-in codes fail open instead, bounded by a per-isolate daily count, so one object's outage cannot end sign-in or the public demo (the platform's 200 a day caps email anyway). Presenting an already-converted file never calls it.
- **Only what must be exact is counted by the Worker.** R2 operations are charged once per request (`charge`) against the exact monthly cap; D1 rows and the rest are read from analytics by the breaker. There is no Workflow layer, so no step meter.
- **One settings reader.** Switches and cap overrides are pure functions of F's single settings snapshot; the launch mode is not a spend switch.
- **Leases carry a deadline.** A pool slot frees itself at deadline plus a grace, and a lease that needed the grace is counted: the Converter did not destroy its container, which the breaker treats as a leak.
- **Kill switches are D1 `setting` rows with a var floor.** The value in force is the more restrictive of the two; an absent row means the default in code; an unknown value counts as the most restrictive. `convert` defaults to `account_only`, so the public internet starts a container only through the demo profile.
- **The breaker** is a function the `*/5` cron calls. It reads the guard's counters and, with a token, the GraphQL Analytics API (which sees what the Worker cannot count, such as presigned R2 PUTs). It flips the matching switch row, latches it until the owner resets it, and sends one alert per trip. Without a token it uses counters alone and says so.
- **A budget, not only caps.** The owner's target is about $10 a month of overage across what has no platform limit. That budget is split by share into a floor per meter per day, and each daily trip line adapts upward with the meter's own trailing p95 (k times it), clamped between the floor and an owner-set ceiling, so limits grow with the project without a code change and cannot grow past the ceiling. A month-to-date cost estimate trips every costly switch at the budget. A weekly digest and a stored report (also served as admin JSON) show the owner the growth before a limit binds.
- **Numbers live in one place**, `src/worker/spend/caps.ts`, each with a var and a reason; `docs/spend.md` is the owner doc and a unit test pins every number in both.
- **Seams:** the module imports no existing module except `SqlLike` (demo-slots.ts), the `Db` slice and `isLocalOrigin`. The composition root builds the `Spend` with `spendFor(env, overrides)` and passes it down; the cron calls `runSpendBreaker(env)`.

## Rejected
- **Rate-limit bindings for the caps:** per location and approximate; kept for per-client smoothing only.
- **D1 counters:** one hot row per meter under load is a latency outage, and a read-then-write over D1 is not atomic. The existing `r2_ops` upsert moves into the guard.
- **A Durable Object per meter or per scope:** more objects, no gain; one object does a few thousand writes a day at this scale.
- **Seeding default rows in the `setting` table:** a default in D1 can drift from the default in code.
- **Platform spend limits alone:** they stop only Workers and Durable Objects and lag; they stay on as the backstop.

## Consequences
- Every costly path pays one Durable Object call. At the planned volumes that is far under the free allowance; an outage of the object stops uploads, conversions and exports, not presenting, sign-in or the demo.
- A latched trip stays until the owner resets it, so a real abuse day does not reopen at 00:00 UTC. An owner who sets a row by hand without resetting sees the breaker put the flip back.
- Refunds are bounded by the guard's own record: it mints the ticket id in `take` (refundable meters only) and stores meter, scope, amount and time, so no caller input can widen a refund.
- The analytics dataset names are unverified until a token exists (docs/spend.md, section 12).
- **New dependency:** none. **Remove:** delete `src/worker/spend/`, its tests and fixture, the `SPEND_GUARD` binding and migration tag, the `*/5` cron and the `setting` rows, and replace each caller's `spendFor` call with the in-Worker cap it needs; the switches would then be read straight from the `setting` lookup.
