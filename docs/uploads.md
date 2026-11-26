# Uploads

How a library file gets into R2 and what each step guarantees. Decision record: [ADR 0017](adr/0017-multipart-uploads.md). Quota rules: [ADR 0013](adr/0013-data-model.md). Threats: [threats/uploads.md](threats/uploads.md). Code: `src/worker/uploads/` (steps), `src/worker/routes/uploads.ts` (HTTP).

## 1. The flow

Every library upload is a multipart upload, whatever its size. Parts are 16 MiB (`UPLOAD_PART_BYTES`), at most 10,000 of them, and a file is at most `LIBRARY_MAX_FILE_BYTES`.

1. **Create**: `POST /api/uploads` with `{name, bytes, fingerprint}` (the fingerprint is 64 hex characters the client derives from the file, the key that makes a retry resume). The answer holds the upload id, the file id, the part size, the parts already stored and the first 8 part URLs (so a small file needs no second round trip).
2. **Parts**: each part goes to its URL. In proxy mode that is `PUT /api/uploads/:id/parts/:n` on the Worker, which streams the body into R2 through a fixed-length stream and records R2's ETag. In direct mode it is a presigned R2 URL and the client then reports the ETag with `POST /api/uploads/:id/parts/:n/done`. More URLs come from `POST /api/uploads/:id/urls` (at most 8 parts a call).
3. **Complete**: `POST /api/uploads/:id/complete`, with `{}` or with the last part's own `{n, etag, bytes}`. The part list always comes from D1 (UP-08). The answer is `ready`, `refused` or `checking`.
4. **Resume**: `POST /api/uploads` with the same file answers the open upload with its stored parts. `GET /api/uploads` lists a user's open uploads and `GET /api/uploads/:id` reads one.
5. **Cancel**: `DELETE /api/uploads/:id` aborts the multipart and returns the reservation. A repeat is a no-op.

Create refuses before it costs anything, in this order: the name's extension (`bad_type`), the size (`too_large`), the open upload of the same file (answered as a resume), the quota and file count (`quota_exceeded`, `library_full`), then the spend takes, then one R2 call, then the D1 reserve. A refused request writes no row and leaves no take behind (W10).

## 2. Quota

`reserved_bytes` and `used_bytes` on `app_user` move only in `src/worker/uploads/quota.ts`, each move one D1 batch whose statements are guarded by the row they move (LIB-02).

| move | when | effect |
|---|---|---|
| reserve | create | inserts the `upload` row and adds the size to `reserved_bytes`, only if the user is active, the size fits the quota, the file count fits and no open upload has the same fingerprint |
| settle | complete, after R2 joined the parts | inserts the `library_file` as `checking`, moves the size from reserved to used, closes the upload |
| release | cancel, expiry, a failed complete | returns the reservation and closes the upload |
| refuse | the check refused the file | takes the size out of `used_bytes`, marks the file `refused` |
| reconcile | nightly | recomputes both counters from the rows and logs any drift |

## 3. Complete and the claim

Complete takes a 120 s claim on the row (`completing_at`). A second complete, a cancel and the sweeps skip a row whose claim is younger. The steps under the claim: join the parts in R2, compare the stored size with the declared one (UP-02), settle, then check. The check reads the stored object once for its SHA-256 and CRC-32 and runs the type validator over the same bytes (`src/worker/uploads/check.ts`); the file is `ready` only with the validated type (UP-05). It ends within 90 s of the claim. If it cannot finish in time, or the R2 read cap refuses it, the file stays `checking` and the next read of the upload, or the sweep, runs it again (UP-12).

## 4. Direct mode and proxy mode

`UPLOAD_MODE` picks the mode. Direct mode mints presigned `UploadPart` URLs for the R2 EU endpoint: one part, one key, PUT only, 300 s (`UPLOAD_URL_TTL_SECONDS`), at most three mints per part per upload. Proxy mode is the fallback and the local and test path; it needs no S3 key. The two share every other step. Direct mode needs the R2 S3 key and the bucket CORS rule from [setup.md](setup.md); until a live check of a presigned part on the EU endpoint passes, the deployed mode stays proxy.

## 5. Cleanup

A library upload expires 20 h after create. Three things remove what a client leaves behind:

- the hourly sweep (`sweepUploads`) finishes or releases a complete whose claim went stale, aborts expired open uploads and deletes closed rows after a day;
- the bucket lifecycle rule aborts any incomplete multipart upload after one day, which also covers a multipart whose D1 row never got written (a Worker that died between the R2 call and the reserve);
- the nightly reconcile heals a counter that drifted.

An object that never reached `ready` is deleted by whichever step refuses or releases it.

## 6. Switches and limits

The `uploads` switch: `on` allows everything; `readonly` refuses a new upload and new part URLs but lets a started upload store parts and complete; `off` refuses every write but a cancel, and a read always works. A refusal is 503 `service_busy`. Every route answers 401 without a signed-in, active member. The routes use `RL_LIBRARY` and `RL_UPLOAD_PART`, keyed by user. Each create takes from the per-user byte and count meters, and each R2 operation is charged to the monthly class A or class B cap once per request ([spend.md](spend.md)).
