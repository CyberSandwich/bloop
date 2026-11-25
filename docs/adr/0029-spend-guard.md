# ADR 0029: spend guard

Status: accepted

## Context
Cloudflare's hard spend limits cover only Workers and Durable Objects. Containers, R2, D1, Workflows, Email and Logs have no platform ceiling, and a conversion container costs real money every second it is up. The public can start work: anyone can open a live screen or the demo and drop a file. The rate-limit bindings are per location, approximate and eventually consistent, so they bound one client but cannot give an exact global count. A bug, a loop or a flood must not produce a surprise bill or exhaust a resource.

## Decision
- **One global Durable Object, `SpendGuard`** (SQLite, eu), holds exact counters per meter per UTC hour, day and month, leases for long jobs, and the breaker's latched state. Its methods are synchronous, so the runtime never interleaves two callers between a check and the write it allows: a cap is exact under any concurrency. A refused take writes nothing.
- **Fail closed.** Callers use `SpendClient`, which turns an unreachable or throwing guard into a refusal (503) and never into a pass. Presenting an already-converted file never calls it.
- **Leases carry a deadline.** A pool slot frees itself at deadline plus a grace, and a lease that needed the grace is counted: the Converter did not destroy its container, which the breaker treats as a leak.
- **Kill switches are D1 `setting` rows with a var floor.** The value in force is the more restrictive of the two; an absent row means the default in code; an unknown value counts as the most restrictive. `convert` defaults to `account_only`, so the public internet starts a container only through the demo profile.
- **The breaker** is a function the `*/5` cron calls. It reads the guard's counters and, with a token, the GraphQL Analytics API (which sees what the Worker cannot count, such as presigned R2 PUTs). It flips the matching switch row, latches it until the owner resets it, and sends one alert per trip. Without a token it uses counters alone and says so.
- **Numbers live in one place**, `src/worker/spend/caps.ts`, each with a var and a reason; `docs/spend.md` is the owner doc and a unit test pins every number in both.
- **Seams:** the module imports no existing module except `SqlLike` (demo-slots.ts), the `Db` slice and `isLocalOrigin`. Callers reach it through `spendFor(env)`; the cron through `runSpendBreaker(env)`.

## Rejected
- **Rate-limit bindings for the caps:** per location and approximate; kept for per-client smoothing only.
- **D1 counters:** one hot row per meter under load is a latency outage, and a read-then-write over D1 is not atomic. The existing `r2_ops` upsert moves into the guard.
- **A Durable Object per meter or per scope:** more objects, no gain; one object does a few thousand writes a day at this scale.
- **Seeding default rows in the `setting` table:** a default in D1 can drift from the default in code.
- **Platform spend limits alone:** they stop only Workers and Durable Objects and lag; they stay on as the backstop.

## Consequences
- Every costly path pays one Durable Object call. At the planned volumes that is far under the free allowance; a fail-closed outage of the object stops uploads, conversions, exports and sends, not presenting.
- A latched trip stays until the owner resets it, so a real abuse day does not reopen at 00:00 UTC. An owner who sets a row by hand without resetting sees the breaker put the flip back.
- The analytics dataset names are unverified until a token exists (docs/spend.md, section 8).
- **New dependency:** none. **Remove:** delete `src/worker/spend/`, its tests and fixture, the `SPEND_GUARD` binding and migration tag, the `*/5` cron and the `setting` rows, and replace each caller's `spendFor` call with the in-Worker cap it needs; the switches would then be read straight from the `setting` lookup.
