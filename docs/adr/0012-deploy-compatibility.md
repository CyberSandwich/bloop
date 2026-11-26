# ADR 0012: deploy and compatibility

Status: accepted. Applies to every migration, Durable Object schema step, Worker-to-object call and wire frame from `migrations/0004_indexes.sql` on. Data model: ADR 0013.

## Context
- A deploy is not atomic. For up to 300 s two versions of the Worker run at once (version skew), and a Durable Object or a page already open in a browser can outlive its deploy by hours.
- `.github/workflows/deploy.yml` runs `wrangler d1 migrations apply DB --remote` on every push to `main`, before `wrangler deploy`. Whatever migration is on `main` is applied to production at once, whether or not the code that needs it has shipped.
- D1 has no transactional DDL across a rebuild and no cheap rollback: Time Travel restores the whole database to a point, losing every later write.

## Decision
- **Additive migrations only.** A migration adds tables, columns (nullable or defaulted) and indexes. It never drops, renames or narrows something the running code reads.
- **Expand, then contract.** A removal or a table rebuild ships one deploy after the code stops needing the old shape, and never in the same deploy that stops needing it.
- **Old code runs on the new schema** through the 300 s skew, and new code runs on the old schema until its migration is applied. Every statement names its columns; none relies on column order or `SELECT *`.
- **No enum CHECK.** The set of values lives in one zod schema; a CHECK would make adding a value a table rebuild. Existing CHECKs are removed only by a rebuild under the rules here (0005 rebuilds `guest_file` once).
- **Worker-to-object RPC changes are additive for one deploy.** A new argument is optional, a new method is added before its caller, and a removed method stays until no deployed code calls it. Durable Object schema changes are one numbered `schemaVersion` step each, never an edit of a shipped `CREATE TABLE` (architecture.md section 8.3).
- **Frames stay readable by the previous page JS.** A new field is optional and ignored by an old client; a changed meaning gets a new field, not a new type for the old one.
- **A monotonic counter that a step restarts restarts above any client value.** A client holding the old counter must never be refused by a reset one.
- **Cron work is sized to the D1 query budget** (the per-invocation subrequest limit) and bounded per statement: every sweep takes a batch size, runs in rounds, and is safe to run twice.
- **The migration lands in the same commit as the code change it requires.** Because every push to `main` applies migrations, a migration that needs a code change to stay safe cannot be separated from it. Migration 0005 ships with two changes: the user-row sweep skips email users (`tid != 'email'`), and the erase route hands email users to the purge (ADR 0013). Without them, the first deploy would let the daily job delete members.
- **A rebuild is rehearsed.** Before an apply that rebuilds a table: apply the migration to a copy restored from a Time Travel point, check the result, and record a Time Travel bookmark immediately before the remote apply. The steps are in `docs/setup.md`.

- **A staging Worker, never synced** (`env.staging`, `docs/setup.md`): its own D1, buckets and Durable Object namespaces, tiny caps and the */5 breaker as its only cron. Its job holds a Cloudflare token, so it runs for the `staging` branch only (an environment branch rule), checks in a job with no token, then deploys from a fresh `npm ci --ignore-scripts` that runs the lockfile's wrangler by path (wrangler and the esbuild it builds with are the only code that sees the token). The token is Workers Scripts plus D1, with no R2 permission.
- **Residual risk of staging:** a token scoped to one account still reaches production's scripts and database in that account. The branch rule and the pinned toolchain narrow who can run code with it; only a separate Cloudflare account removes it, which is an optional owner step.

## Rejected
- **Applying migrations by hand after review:** a second path that drifts from `main`, and a deploy that waits on a person.
- **Blue-green, or a staging database synced from production:** a sync problem for one operator; the rehearsal copy gives the same check for the rare rebuild.
- **Enum CHECK constraints with a rebuild per value:** each rebuild is a risk window; zod already checks every write.
- **Versioned wire frames:** more machinery than optional fields need.

## Consequences
- Some cleanup waits a deploy: dead columns and tables stay until the contract step.
- A migration review asks one question: does the previous commit still work on it?
- A broken migration on `main` is in production within minutes, so the rehearsal and the bookmark are the safety net, not CI.

## Threats served
LIB-09 (retention jobs bounded and safe to repeat), AUTH-13 (a restore never silently keeps revoked sessions, see the restore steps in `docs/setup.md`), and the deploy-time half of SITE-04.

## How to remove it
Nothing to remove: it is a rule, not code. If migrations stop auto-applying, the "same commit" rule relaxes to "same release".
