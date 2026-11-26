# ADR 0019: the Converter, a Durable Object driven by alarms

Status: accepted

## Context
An uploaded deck, document, video or HEIC photo must become what bloop shows (slide images, a PDF, notes, an H.264 video) before anyone can present it from the phone. The work runs in a container (`container/README.md`, no network, one job per container). Something has to start the container, feed it the original, wait, check what comes out and store it, and it must not leave a container running or a lease held on any path. A container costs money every second it is up.

## Decision
- **One Durable Object per file version** (`idFromName("<fid>:v<n>")`, `eu`), `Converter`, runs one job at a time with alarms. Each alarm does one bounded unit (a health window, up to 4 input chunks, one 25 s status poll, one store unit) and names the next phase; the record (`v: 1`, zod-parsed on every wake) is the only state. All logic is `src/worker/convert/runner.ts`, which takes its platform as injected dependencies, so it is tested under Node over fakes; the class in `src/worker/do/converter.ts` only wires them.
- **No Workflow.** A Workflow adds a second state machine, a per-step meter, an instance cap to defend and a termination path for purges, and gives nothing the alarm machine lacks: a job here is a loop of short waits with a deadline.
- **The D1 `derived` row is the truth** and the Converter's record is private. Every write is one statement guarded by `(file_id, version, run_id)` and the prior status, so a stale Converter changes nothing and is told so. One run per version: `claimRun` is one statement with one winner, a version gets at most two container starts across every claim, and final failure codes are never started again.
- **A fresh container per attempt** (destroy, then start; the job id carries the attempt) and the platform's no-internet flag set explicitly.
- **Every output claim is checked again** (`outputs.ts`): the manifest, each path against an anchored grammar, each file's size and SHA-256 as it streams, its head and tail by type, and the three JSON files by schema. The Converter, not the container, writes the `slides.json` the viewer reads, from checked values only. A failing group is dropped and the others publish; a manifest fault fails the job, so a compromised container cannot choose the survivor.
- **One pack per width** (`d/s/<w>.pack`, offsets in `slides.json`, read by Range), so a 300-slide deck is about 10 R2 writes instead of about 900. Page 1 and the thumbnail are also stored whole, for the early preview.
- **The cost bounds stack:** the guard's pool and daily seconds, a deadline checked on every alarm, the container's own inactivity stop as a second, the sweep as a third, and the breaker's overdue-lease trip behind them.

## Rejected
- **A Workflow per conversion:** see above; it also needs its own residency answer and a purge path.
- **A queue and a consumer Worker:** no fan-out to justify it; one version is one job.
- **One R2 object per page and width:** about 900 puts for a full deck, the largest class A line.
- **Trusting the container's manifest:** a size or a hash it declares is a claim, never a measure.

## Consequences
- **The residual risk** is output that is header-valid but hostile to a decoder. It stays in the same user's prefix, is served under a fixed type, `nosniff` and a sandbox CSP, and the viewer workers have no network.
- **A per-day conversion take is not refunded** when a run is skipped after it (the guard refunds only `container_seconds` and the upload meters): a job that waits 30 minutes for a slot and gives up costs the user one of their daily conversions.
- **Video** timeouts, the remux rule and the transcode cap belong to the container and live in `container/README.md`; the video slice sizes its deadline from those numbers.
- **The image reference** is `registry.cloudflare.com/<account>/bloop-converter@<digest>`; Cloudflare has no account-less form, and the repo must not hold the account id. `wrangler.jsonc` holds all-zero placeholders in the shape wrangler checks; the deploy fills the digest from `container/digest.txt` (`prebuilt.mjs rewrite`) and, in the wrangler step that already holds the secret, the account (`prebuilt.mjs account`, which refuses an unset or malformed id). A deploy that skipped either fails closed.
- **Remove it** by deleting `src/worker/convert/`, `do/converter*.ts`, the `CONVERTER` binding and its migration tag, the `containers` entry, and the `convert_sweep` cron job; the `derived` table and the stored outputs stay readable.
