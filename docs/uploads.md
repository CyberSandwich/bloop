# Uploads

How a library file gets into R2 and what each step guarantees. Decision record: [ADR 0017](adr/0017-multipart-uploads.md). Quota rules: [ADR 0013](adr/0013-data-model.md). Threats: [threats/uploads.md](threats/uploads.md). Code: `src/worker/uploads/` (steps), `src/worker/routes/uploads.ts` (HTTP).

## 1. The flow

Every library upload is a multipart upload, whatever its size. Parts are 16 MiB (`UPLOAD_PART_BYTES`), at most 10,000 of them, and a file is at most `LIBRARY_MAX_FILE_BYTES`.

1. **Create**: `POST /api/uploads` with `{name, bytes, fingerprint}` (the fingerprint is 64 hex characters the client derives from the file, the key that makes a retry resume). The answer holds the upload id, the file id, the part size, the parts already stored and the first 8 part URLs (so a small file needs no second round trip).
2. **Parts**: each part goes to its URL. In proxy mode that is `PUT /api/uploads/:id/parts/:n` on the Worker, which streams the body into R2 through a fixed-length stream and records R2's ETag. A body of the wrong length is `bad_request`, a multipart R2 no longer has is `upload_aborted`, and any other R2 fault is a retryable `service_busy`; none records the part. In direct mode it is a presigned R2 URL and the client then reports the ETag with `POST /api/uploads/:id/parts/:n/done`; proxy mode refuses that route (`bad_request`), so no client can overwrite an ETag R2 gave the Worker (UP-08). More URLs come from `POST /api/uploads/:id/urls` (at most 8 parts a call).
3. **Complete**: `POST /api/uploads/:id/complete`, with `{}`, or in direct mode with the last part's own `{n, etag, bytes}`, where `n` must be the final part. That body is checked before the claim: a bad one, or any `last` in proxy mode, is a plain `bad_request` that changes nothing. The part list always comes from D1 (UP-08). The answer is `ready`, `refused` or `checking`; a repeat answers the settled file.
4. **Resume**: `POST /api/uploads` with the same file answers the live upload (open and unexpired) with its stored parts. The fingerprint is the file's key: the same fingerprint with another name or size is `bad_request`, before any reserve or take. `GET /api/uploads` lists a user's live uploads and `GET /api/uploads/:id` reads one; that read is pure (no check, no R2 read, no charge, no settings read).
5. **Cancel**: `DELETE /api/uploads/:id` returns the reservation, then aborts the multipart and deletes any object R2 already joined (a client can vanish between R2's complete and the settle). A repeat is a no-op.

Create refuses before it costs anything, in this order: the name's extension (`bad_type`), the size (`too_large`), the live upload of the same file (answered as a resume), then the D1 reserve, whose guards are the quota, the file count and the twin (`quota_exceeded`, `library_full`; so a user over quota always hears the quota refusal), then the spend takes, then one R2 call. A failure after the reserve releases it and refunds the takes, so a refused request leaves no reservation and no take (W10). A reserve whose D1 answer was lost after it committed is read back by its id and goes on; one the Idempotency-Key index refused (two requests with one key raced) answers the winner's upload for the same body and `bad_request` for another.

## 2. Quota

`reserved_bytes` and `used_bytes` on `app_user` move only in `src/worker/uploads/quota.ts`, each move one D1 batch whose statements are guarded by the row they move (LIB-02).

| move | when | effect |
|---|---|---|
| reserve | create | inserts the `upload` row and adds the size to `reserved_bytes`, only if the user is active, the size fits the quota, the file count fits (`checking` and `ready` files plus live uploads; a refused file takes no slot) and no live upload has the same fingerprint; a refusal whose cause is gone when read back is tried again, never guessed |
| settle | complete, after R2 joined the parts | inserts the `library_file` as `checking`, moves the size from reserved to used, closes the upload |
| release | cancel, expiry, an inactive owner, a failed complete | returns the reservation and closes the upload |
| refuse | the check refused the file, or it stayed `checking` a day | takes the size out of `used_bytes`, marks the file `refused` |
| reconcile | nightly | recomputes both counters from the rows and logs any drift |

## 3. Complete and the claim

Complete takes a 120 s claim on the row (`completing_at`). A second complete, a cancel and the sweeps skip a row whose claim is younger. The steps under the claim: join the parts in R2, compare the stored size with the declared one (`size_mismatch`, UP-02), settle, then check. The check reads the stored object once for its SHA-256 and CRC-32 and runs the type validator over the same bytes (`src/worker/uploads/check.ts`, UP-13); the file is `ready` only with the validated type (UP-05), and `afterReady` runs only when that write won: it starts the file's conversion (`src/worker/uploads/convert-ready.ts`), after the response on a complete and inline in the sweep, and never fails the upload. The class B reads are charged up front (`readBudget`), and a validator that asks for more ranged reads than were charged gets nothing more and the file is `bad_structure`. The check ends within 90 s of the claim. If it cannot finish in time, or the R2 read cap refuses it, the file stays `checking`; a repeat of complete, or the sweep, runs it again, and a file still `checking` a day after it settled is refused as `service_busy` (UP-12).

**The ordering rule.** Wherever bytes and quota meet, the guarded D1 move (release, refuse, a guest close) runs first and the R2 object and multipart are deleted only when that move won (`src/worker/uploads/reclaim.ts`, the one place that deletes; a unit test greps for any other). A loser deletes nothing and answers the row as it stands: a complete whose stale claim another claimant settled answers that settled file. Residual: a Worker that dies between the move and the delete leaves an object no row counts.

## 4. Direct mode and proxy mode

`UPLOAD_MODE` picks the mode. Direct mode mints presigned `UploadPart` URLs for the R2 EU endpoint: one part, one key, PUT only, 300 s (`UPLOAD_URL_TTL_SECONDS`), at most three mints per part per upload. Proxy mode is the fallback and the local and test path; it needs no S3 key. The two share every other step. Direct mode needs the R2 S3 key and the bucket CORS rule from [setup.md](setup.md); until a live check of a presigned part on the EU endpoint passes, the deployed mode stays proxy.

## 5. Cleanup

A library upload expires 20 h after create. Three things remove what a client leaves behind:

- the hourly sweep (`sweepUploads`) finishes or releases a complete whose claim went stale, releases expired open uploads and those of an owner no longer active (a suspended member's routes answer 401, so the sweep returns the reservation within the hour), checks again a file left `checking` past the claim window (or refuses it after a day), starts the conversion of ready, servable files that have no `derived` row (oldest first, bounded by the allotment, and not at all while `CONVERT_MODE` is `off`, so the backlog is taken whole once it is on), and deletes closed rows after a day. A row that throws is logged (`upload_sweep_failed`, its id only) and skipped. A run stops at `SWEEP_WALL_MS` (240 s) or a full allotment and reports `more` to the cron dispatcher;
- the bucket lifecycle rule aborts any incomplete multipart upload after one day, which also covers a multipart whose D1 row never got written (a Worker that died between the R2 call and the reserve);
- the nightly reconcile heals a counter that drifted.

An object that never reached `ready` is deleted by whichever step refuses or releases it, under the ordering rule (section 3). A Worker that dies between a won release or refusal and its delete leaves a joined object nothing counts; the closed row (or refused file) still names its key, so the hourly sweep deletes the key again for a day. The sweep's file lookups use `idx_library_file_status` (migration 0008).

## 6. Switches and limits

The `uploads` switch: `on` allows everything; `readonly` refuses a new upload and new part URLs but lets a started upload store parts and complete; `off` refuses every write but a cancel, and a read always works. A refusal is 503 `service_busy`. Every route answers 401 `auth_required` without a signed-in, active member. A write is checked on its headers before anything else: Origin and Sec-Fetch-Site (403), and on a JSON write its type and a declared `Content-Length` of at most 4096 bytes (411 without one, 413 over it); only then come the per-IP meter (`RL_MEMBER_IP`, before any D1 read), the session, the per-user rate limit and the row, and one settings read for the switch and the spend overrides. In direct mode a part may be minted three times, plus 8 more per URL lifetime since create, so a resume past the budget waits (`rate_limited` with a Retry-After) and is never locked out. The routes use `RL_LIBRARY` and `RL_UPLOAD_PART`, keyed by user. Each create takes from the per-user byte and count meters, and each R2 operation is charged to the monthly class A or class B cap once per request ([spend.md](spend.md)).
