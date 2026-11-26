# ADR 0017: multipart uploads

Status: accepted for the proxy path; the direct path is built and unit-tested, and goes live after the live check in section "Consequences". Follows ADR 0013 (quota columns, the `upload` and `upload_part` tables) and ADR 0029 (the spend guard). Operating detail: [uploads.md](../uploads.md).

## Context
- A Worker request body is limited to 100 MB, so a library file (up to 500 MB) cannot go through one request.
- The browser can PUT parts straight to R2 on presigned URLs, which keeps the bytes off the Worker, but that needs an R2 S3 key and a bucket CORS rule that only the owner can create.
- Quota and cost caps must hold under concurrent requests, a client that retries, and a Worker that dies between two steps.

## Decision
- **Every upload is multipart**, 16 MiB parts, at most 10,000. One path for a 1 MB deck and a 450 MB video; a resume is the same call as a create.
- **Two modes behind one interface.** Proxy: the part goes through the Worker (`FixedLengthStream` into `uploadPart`). Direct: the Worker mints a presigned `UploadPart` URL per part (300 s, one part, one key, at most three mints per part) and the client confirms the ETag. `UPLOAD_MODE` chooses; proxy is the default, the fallback and the local path.
- **Upload ids come only from D1.** A client names an upload by its own id, never R2's, and the part list at complete is read from `upload_part`, never from the request (the last part's own report may ride on complete and is checked against R2's join).
- **Quota is moved by guarded D1 batches** (ADR 0013): reserve at create, settle at complete, release on cancel or expiry, refuse after a failed check, reconcile nightly. Nothing else writes the two counters.
- **Complete is claim-based.** A 120 s claim stops a second complete, a cancel and the sweeps from racing it; the check ends 90 s after the claim, and a check that cannot finish leaves the file `checking` for the next read or sweep.
- **One validation read.** The stored object is read once for SHA-256 and CRC-32, and the format validator (`src/worker/seams/guest-drop/validate.ts`, shared with the guest drop) runs over the same bytes. The stored type is the validated type.
- **Spend.** Create takes per-user bytes and count (refundable) before any R2 call; each R2 operation is charged to the class A or B cap once per request. A refusal is 429 or 503 through the same mapping every route uses.
- **Idempotency-Key** on create (`src/worker/idem.ts`): the same key and body replays the first answer; the same key with another body is `bad_request`.
- **Cleanup.** A library upload expires after 20 h; the hourly sweep finishes or releases crashed completes and expired uploads; the bucket's one-day multipart abort rule is the backstop for a multipart with no row.

## Consequences
- A Worker that dies between `createMultipartUpload` and the D1 reserve leaves an R2 multipart with no row. The lifecycle rule aborts it within a day; it holds no billed object until complete.
- A race can answer `rate_limited` where a sequential run would answer `quota_exceeded`, because the spend take happens before the reserve.
- Direct mode is unproven against the live EU endpoint (presigned `UploadPart` and the CORS preflight). Until the owner sets the R2 S3 key and the check passes, production runs proxy mode, and the 100 MB request limit is not a limit on file size because parts are 16 MiB.
- The local R2 emulator returns ETags in a different form from R2; the routes accept both.
