# ADR 0030: one-tap lockdown

Status: accepted

## Context
Cutting cost or locking the service meant the Cloudflare dashboard: slow on a phone, and a click-path an owner under pressure gets wrong. The switches live in D1 rows (ADR 0029) and a Worker variable floor, so a command can set them; the platform pieces (a WAF rule, workers.dev, cron triggers) have an API.

## Decision
- **A workflow plus a script, one rung table.** `.github/workflows/lockdown.yml` is a `workflow_dispatch` the GitHub phone app can run; `tools/lockdown.mjs` is the same ladder on a Mac. Both read `tools/lockdown-rungs.json`, so the phone and the Mac cannot drift. The script is the logic and the workflow is a thin caller.
- **Dry run by default, idempotent, undoable.** A rung reads state first and writes only on a difference. Every rung has an undo. Rows go through `wrangler d1 execute --remote` with SQL built only from the table, plus an `admin_action` line for the write.
- **Nothing is deleted.** The script refuses any DELETE and any write to a script, bucket, database or Durable Object class, because deploying a script named `bloop` without its classes erases their data.
- **A separate lockdown token.** L3 to L5 need permissions the deploy token lacks (the zone WAF), and widening the deploy token widens what a leaked deploy token can do. The lockdown token is its own secret; L1 and L2 may fall back to the deploy token.
- **No new dependency.** Node built-ins, `fetch`, and the wrangler already installed.

## Replaces
The owner's dashboard click-paths for L1 to L5, and a hand-run `wrangler d1 execute`.

## Remove
Delete `.github/workflows/lockdown.yml`, `tools/lockdown.mjs`, `tools/lockdown-rungs.json`, `test/unit/lockdown.test.ts`, `docs/lockdown.md` and this ADR. Nothing else imports them.
