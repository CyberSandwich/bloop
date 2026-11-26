# Conversion

What only this doc holds: the states, the codes and their copy, the R2 layout, the profiles and the deadline, the progress frames. Why a Durable Object with alarms: `docs/adr/0019-converter.md`. The job contract with the container: `container/README.md`. Caps, switches and the per-day takes: `docs/spend.md`. Threats: `docs/threats/conversion.md`. The code is `src/worker/convert/` and `src/worker/do/converter.ts`.

## 1. States

The D1 `derived` row (one per file version) is the truth every page reads. The Converter's record is private.

| status | meaning |
|---|---|
| `queued` | claimed; `stage` is empty until the Converter starts, `waiting` while it waits for a free converter |
| `running` | a container holds the job; `stage` is `starting`, `upload`, then the container's own stage names |
| `done` | outputs stored; `outputs` lists exactly what was stored |
| `failed` | `error` is a code from section 2 |
| `skipped` | no container ran; `error` is a code from section 2 |
| `cancelled` | the file was trashed, disabled, purged or its guest ended |

- **Entry** is only `startConversion` (`start.ts`), called by upload complete, Try Again, and the guest and demo drops. It never throws and answers `queued`, `exists` (a run is live or done, or the version has used its starts) or `skipped` with a code. A file that is gone writes no row (`gone`).
- **Order of refusals:** CONVERT_MODE, the file, an unsupported type, video (the demo never converts video), the `convert` switch, a guest on the full profile under `account_only`, a deadline over the lease maximum, the queue caps (100 overall, 5 per user, 10 for guests and the demo), then the claim and the per-day take. A refusal is on the row, so the page can say why.
- **Re-entry** is only through the claim. It is allowed from `skipped` and `cancelled`, and from `failed` only with a retryable code and fewer than 2 container starts; `done` is never re-entered. `attempts` rises once per container start and never resets.
- **End:** `cancelConversion` marks the row first, then ends the Converter's run (container, lease, stored keys). The sweep (`*/5`) asks the Converter of every live row nobody has touched for 10 minutes: no record fails the row `interrupted`, a stopped alarm is re-armed, a run past its deadline is ended. It never queues.

## 2. Codes and what a person reads

Codes are final unless marked retryable (`start_failed`, `interrupted`, `store_failed`: one new container, at most 2 starts per version). The original file always stays presentable, so every line names a way forward. A test fails when a code here is missing from `src/worker/convert/codes.ts`, or the reverse. The library row and the screen implement this wording; until their copy lands, this table is its only home.

| code | user sees | action |
|---|---|---|
| `off`, `account_only` | Slides Aren't Available Right Now. | Present in PowerPoint or Download |
| `video_off` | Video Conversion Is Paused. | Download |
| `daily_limit` | You've Reached Today's Conversion Limit. It Resets at Midnight UTC. | Try Again Tomorrow or Download |
| `daily_budget`, `busy`, `queue_full` | bloop Is Busy Converting Other Files. | Try Again |
| `start_failed`, `interrupted`, `store_failed` | Conversion Was Interrupted. | Try Again |
| `bad_magic`, `unsupported` | This File Isn't What Its Name Says. | Re-save It and Upload Again |
| `bad_archive`, `bomb` | This File Looks Damaged or Unsafe to Open. | Re-save It and Upload Again |
| `too_many_pages` | bloop Shows Up to 300 Pages. | Split the File or Present in PowerPoint |
| `too_large` | This File Is Too Large to Convert. | Download |
| `bad_page_size` | A Page in This File Has an Unusual Shape. | Export as PDF and Upload That |
| `bad_media` | This Video or Photo Can't Be Converted. | Download |
| `convert_failed` | This File Couldn't Be Converted. | Export as PDF and Upload That |
| `timeout`, `deadline` | Converting This File Took Too Long. | Split the File or Download |
| `output_invalid`, `input_mismatch`, `input_missing`, `internal` | Something Went Wrong Converting This File. | Download |

A demo deck with more pages than it renders is `done`: "Showing the first 40 of 60 slides" (the counts are in `outputs`). A missing font is not a failure: "Shown With a Similar Font: Aptos". While running, the stage is named ("Preparing Slides", then "12 of 40 Slides"); `waiting` reads "Waiting for a Free Converter". A final code hides Try Again.

## 3. The Converter's phases

One alarm does one bounded unit, then sets the next alarm or ends the job. The deadline is checked on every alarm and destroys unconditionally; an unknown throw is counted and the seventh alarm in a row fails the attempt `interrupted`.

| phase | one alarm does |
|---|---|
| `admit` | re-reads the row, the file and the switches; refuses or goes on |
| `lease` | takes a pool slot, then the container seconds; busy waits `retryAfter` plus 0 to 5 s of jitter, for 30 minutes at most |
| `start` | destroys any container, starts a fresh one (no internet, `standard-2`), arms its inactivity stop |
| `health` | polls `/healthz` for 10 s; a container not up after 90 s is `start_failed` |
| `input` | sends up to 4 chunks of 64 MiB, then starts the job with the size, SHA-256 and chunk count; resumes at the next unsent chunk |
| `run` | polls `/job/status` for 25 s; a stage change goes to D1, page counts only to the watcher |
| `store` | one unit: the manifest and the JSON files, then page 1, then one pack per width, the PDF, the notes, the media or image, and last `slides.json` |
| `publish` | one guarded write of the outputs |
| `finish` | destroys the container, releases the lease, refunds unused seconds, tells the watcher, deletes what a failed run wrote; the record is deleted an hour later |

Spend calls in order: `take` the per-day meter (`start.ts`), `acquire`, `take("container_seconds")`, `release` and `refund` of the unused seconds, `record("conversion_done" or "conversion_failed")`.

## 4. Stored layout

The prefix is the original's key without `/orig`, read from D1, never from a caller. Only names that match the stored grammar (`STORED` in `outputs.ts`) become keys.

| owner | bundle (`/b/`, `/p/`) | phone only |
|---|---|---|
| library | `u/<uid>/<fid>/v<n>/d/…` | `u/<uid>/<fid>/v<n>/n/notes.json` |
| guest, demo | `g/<ref>/d/…` | `g/<ref>/n/notes.json` |

`d/` holds `slides.json`, `t.webp`, `s/1/<w>.webp`, `s/<w>.pack`, `doc.pdf`, `m/0.mp4` and `i/1920.jpg`, only for the groups that passed. `meta.json` is read, never stored. `bundleAllowlist` is the served set (notes and meta never). A pack is the pages' WebP files one after another; `slides.json` (`v: 2`) carries each page's `[start, length]`. A pack's `sha256` in `outputs` is the digest of its pieces' hashes, since R2 cannot hash a streamed object as a whole.

A guest's end deletes everything under `g/<ref>/` as well as the original (`R2GuestDrop.purge`). The manifest is read once, checked, and pinned by its digest in the plan: a later unit that sees a different manifest fails the run. Every call to the container is cut at the run's deadline, and a status or error body is capped at 2 MiB.

Groups are `slides`, `pdf`, `notes`, `media` and `image`. A document is done when `slides` or `pdf` passed; bad notes only clear `has_notes`; a failed media or image group fails the job.

## 5. Profiles and the deadline

| | `full` | `demo` |
|---|---|---|
| who | accounts; guests only when `convert` is `on` | the demo drop, also under `account_only` |
| pages, widths | 300, 3840 1920 480 | 40, 1920 480 |
| output total | 4 GiB | 200 MiB |
| pool, per-day meter | `convert` with `convert_user`; guests `convert_public` with `convert_guest` | `convert_public` with `convert_demo` |

The deadline is `90 boot + (30 + bytes / 4 MiB/s) input + the stages + (120 + 0.5 s per page) store + 60 slack`, where the stages are the container's own timeouts (`container/README.md`) plus a font pass, and a second convert for `ppt`, `pps` and `odp`. A deadline over the lease maximum is refused before any start as `too_large`.

## 6. Progress

Each frame is an upsert keyed by `(fileId, version)`: an older version is ignored, a terminal state is never overwritten, and the D1 row is the truth on reconnect. Frames go out at most once a second, `done` only rises, and `pageReady` is sent after page 1 is stored and before the first pack. A watcher that lacks a method is logged once (`convert_notify_missing`) and the job goes on.

## 7. Stub mode

`CONVERT_MODE=stub` (refused on a non-local origin) replaces the container with a fake job server that answers the same contract with tiny structurally valid outputs. The original's first bytes choose a failure: `BLOOP-STUB:` then `timeout`, `bomb`, `bad_webp`, `extra_file`, `slow`, `crash_once`, `pages60` or `pages301`.

## 8. Not yet measured

Cold start, and timings for 20, 100 and 300 slides on the deployed instance, are written here once the staging checks have run.
