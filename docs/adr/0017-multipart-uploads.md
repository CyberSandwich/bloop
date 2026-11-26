# ADR 0017: multipart uploads

Status: accepted for the proxy path; the direct path is built and unit-tested, and goes live after the live check in section "Consequences". Follows ADR 0013 (quota columns, the `upload` and `upload_part` tables) and ADR 0029 (the spend guard). Operating detail: [uploads.md](../uploads.md).

## Context
- A Worker request body is limited to 100 MB, so a library file (up to 500 MB) cannot go through one request.
- The browser can PUT parts straight to R2 on presigned URLs, which keeps the bytes off the Worker, but that needs an R2 S3 key and a bucket CORS rule that only the owner can create.
- Quota and cost caps must hold under concurrent requests, a client that retries, and a Worker that dies between two steps.

## Decision
- **Every upload is multipart**, 16 MiB parts, at most 10,000. One path for a 1 MB deck and a 450 MB video; a resume is the same call as a create.
- **Two modes behind one interface.** Proxy: the part goes through the Worker (`FixedLengthStream` into `uploadPart`). Direct: the Worker mints a presigned `UploadPart` URL per part (300 s, one part, one key, at most three mints per part) and the client confirms the ETag. `UPLOAD_MODE` chooses; proxy is the default, the fallback and the local path.
- **Upload ids come only from D1.** A client names an upload by its own id, never R2's, and the part list at complete is read from `upload_part`, never from the request. In direct mode the final part's own report may ride on complete, is checked before the claim and against R2's join; proxy mode takes no client ETag at all (no `/done`, no `last`).
- **Quota is moved by guarded D1 batches** (ADR 0013): reserve at create, settle at complete, release on cancel, expiry or an inactive owner, refuse after a failed check, reconcile nightly. Nothing else writes the two counters. "Live" (open and unexpired) is one definition shared by resume, the listing and the reserve's twin and file-count guards; a refused file takes no file slot.
- **The ordering rule.** The guarded D1 move runs first; R2's object and multipart are deleted only when it won, through one helper (`src/worker/uploads/reclaim.ts`). A loser deletes nothing and answers the row as it stands, so two claimants can never delete a live file.
- **Complete is claim-based.** A 120 s claim stops a second complete, a cancel and the sweeps from racing it; the check ends 90 s after the claim, and a check that cannot finish leaves the file `checking` for a repeat of complete or the sweep, which refuses it after a day. Reading an upload never reruns a check.
- **One validation read.** The stored object is read once for SHA-256 and CRC-32, and the format validator (`src/worker/seams/guest-drop/validate.ts`, shared with the guest drop) runs over the same bytes, held to the reads charged for it. The stored type is the validated type.
- **Spend.** Create takes per-user bytes and count (refundable) before any R2 call; each R2 operation is charged to the class A or B cap once per request. A refusal is 429 or 503 through the same mapping every route uses. Direct-mode mints are three per part plus a batch per URL lifetime, so a resume waits rather than locks out.
- **Idempotency-Key** on create (`src/worker/idem.ts`): the same key and body replays the first answer; the same key with another body is `bad_request`, including when the two race into the unique index.
- **Cleanup.** A library upload expires after 20 h; the hourly sweep finishes or releases crashed completes, expired uploads and those of an inactive owner, and settles files left `checking`, within a wall-time budget, skipping a row that throws; the bucket's one-day multipart abort rule is the backstop for a multipart with no row. A joined object stranded between a won release and its delete needs no tombstone table: the closed row still names its key, and the hourly sweep deletes it again for the day it keeps the row (24 tries).

## Consequences
- A Worker that dies between `createMultipartUpload` and the D1 reserve leaves an R2 multipart with no row. The lifecycle rule aborts it within a day; it holds no billed object until complete.
- A race can answer `rate_limited` where a sequential run would answer `quota_exceeded`, because the spend take happens before the reserve.
- Direct mode is unproven against the live EU endpoint (presigned `UploadPart` and the CORS preflight). Until the owner sets the R2 S3 key and the check passes, production runs proxy mode, and the 100 MB request limit is not a limit on file size because parts are 16 MiB.
- The local R2 emulator returns ETags in a different form from R2; the routes accept both.
- A missing multipart is told from other R2 part faults by R2's NoSuchUpload code (10024), unverified against the live binding; a miss answers `service_busy` (retry) instead of `upload_aborted`.
- A Worker that dies between a won release and the delete leaves an object that no row names and the lifecycle rule does not cover (it only aborts unjoined multiparts).
- A suspended member's routes answer 401, so the open upload waits for the next hourly sweep to return its reservation.
