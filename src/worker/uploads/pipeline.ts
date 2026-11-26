// The upload steps behind /api/uploads (ADR 0017): create, mint part URLs, store a part, confirm it, complete, abort and
// read back. Plain functions over injected deps, so a unit test runs them on node:sqlite and a fake bucket. The
// routes (routes/uploads.ts) own the guard, the auth and the status codes; nothing here knows a Request.
//
// Order of every create: refusals that cost nothing, then the D1 reserve (a quota refusal is never masked by a spend
// one), then the spend takes, then R2; a failure after the reserve releases it and refunds the takes, so a refused
// request leaves no reservation, no take and no R2 upload (W10). A library upload and (with the guest owner) a guest's
// differ only in what reserve and settle do.
import type { AppError, ErrorCode } from "../../shared/protocol.ts";
import type { BatchDb } from "../auth/db.ts";
import type { Config } from "../config.ts";
import { newRef } from "../ids.ts";
import type { FormatType } from "../seams/guest-drop/formats.ts";
import type { Spend } from "../spend/client.ts";
import { refusal } from "../spend/client.ts";
import { checkStored } from "./check.ts";
import type { Multipart } from "./multipart.ts";
import { claimCheck, markReady, refuseLibrary, releaseLibrary, reserveLibrary, settleLibrary } from "./quota.ts";
import * as store from "./store.ts";
import { libraryTypeOf } from "./types.ts";

/** Most part URLs one request mints, and the most create answers with (O5). */
export const MINT_BATCH = 8;
/** The database wall: R2's own limit on parts in one multipart upload. */
const MAX_PARTS = 10_000;
/** A library upload expires under the bucket lifecycle's one-day abort (R4). */
const LIBRARY_EXPIRY_MS = 20 * 3_600_000;
/** The check ends this long after complete's claim, before the claim goes stale. */
const CHECK_WALL_MS = 90_000;

export type Out<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorCode | AppError; retryAfter?: number | undefined };
const no = (error: ErrorCode | AppError, retryAfter?: number): Out<never> => ({
  ok: false,
  error,
  retryAfter,
});
const yes = <T>(value: T): Out<T> => ({ ok: true, value });

export interface Presigner {
  part(row: store.UploadRow, n: number, bytes: number): Promise<{ url: string; expiresAt: number }>;
}

export interface Deps {
  db: BatchDb;
  mp: Multipart;
  spend: Pick<Spend, "take" | "charge" | "refund">;
  config: Config;
  now: () => number;
  /** Set when direct mode is configured: the signer of part URLs. Absent means every upload goes through the Worker. */
  presigner?: Presigner;
  /** Called once a library file is `ready` (V's conversion start). */
  afterReady?: (file: { id: string; userId: string; ext: string }) => Promise<void>;
}

export interface PartUrl {
  n: number;
  url: string;
  expiresAt?: number;
}

export interface CreateAnswer {
  uploadId: string;
  fileId: string;
  partBytes: number;
  parts: number;
  done: number[];
  mode: "direct" | "proxy";
  expiresAt: number;
  urls: PartUrl[];
  /** How long a direct URL works, so the client measures expiry on its own clock. */
  ttlMs: number;
}

export interface FileState {
  id: string;
  status: "checking" | "ready" | "refused";
  refusal?: string;
}
export interface CompleteAnswer {
  state: "ready" | "refused" | "checking";
  file: FileState;
}

const modeOf = (d: Deps): "direct" | "proxy" => (d.presigner ? d.config.library.uploadMode : "proxy");

/** The size of part `n`: every part is `partBytes` but the last, which holds the remainder. */
export const partSize = (u: Pick<store.UploadRow, "bytes" | "partBytes" | "parts">, n: number): number =>
  n < u.parts ? u.partBytes : u.bytes - u.partBytes * (u.parts - 1);

const validPart = (u: Pick<store.UploadRow, "parts">, n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= u.parts;

/** R2's ETag without its quotes; its case matters (R2 compares it exactly on complete). */
const cleanEtag = (etag: string): string => etag.replaceAll('"', "");

/** A refused spend take or charge as the error the route answers. */
function spendFailure(result: Parameters<typeof refusal>[0]): Out<never> {
  const r = refusal(result);
  return no(r.code, r.retryAfterSeconds);
}

// ---- create ----

export interface CreateRequest {
  name: string;
  bytes: number;
  fingerprint: string;
  /** SHA-256 of the Idempotency-Key header, when the client sent one. */
  idemKey: string | null;
}

/** The answer for an upload that already exists (a resume, an idempotent replay): no take, no R2 call, no write. */
export async function answerFor(d: Deps, row: store.UploadRow): Promise<Out<CreateAnswer>> {
  const done = (await store.doneParts(d.db, row.id)).map((p) => p.n);
  const pending = Array.from({ length: row.parts }, (_, i) => i + 1).filter((n) => !done.includes(n));
  const minted = await mint(d, row, pending.slice(0, MINT_BATCH));
  if (!minted.ok) return minted;
  return yes({
    uploadId: row.id,
    fileId: row.fileId,
    partBytes: row.partBytes,
    parts: row.parts,
    done,
    mode: modeOf(d),
    expiresAt: row.expiresAt,
    urls: minted.value,
    ttlMs: d.config.library.urlTtlSeconds * 1000,
  });
}

/** Creates a library upload, or resumes the open one of the same file. */
export async function createLibrary(
  d: Deps,
  userId: string,
  req: CreateRequest,
): Promise<Out<{ created: boolean; answer: CreateAnswer }>> {
  const { library } = d.config;
  const owner: store.Owner = { kind: "library", userId };
  const type: FormatType | null = libraryTypeOf(req.name);
  if (!type) return no("bad_type");
  if (req.bytes > library.maxFileBytes) return no("too_large");
  const parts = Math.ceil(req.bytes / library.partBytes);
  if (parts > MAX_PARTS) return no("too_large");

  const resumed = await resume(d, owner, req);
  if (resumed) return resumed;

  const limits = { quotaBytes: library.quotaBytes, maxFiles: library.maxFiles };
  // The reserve comes first, so a user over their quota always hears `quota_exceeded` and never a spend refusal that a
  // concurrent request's take caused. The row carries no R2 upload id until R2 answers; every later failure releases it.
  const fileId = newRef();
  const key = `u/${userId}/${fileId}/v1/orig`;
  const now = d.now();
  const row: store.NewUpload = {
    id: newRef(),
    owner,
    fileId,
    r2Key: key,
    r2UploadId: "",
    name: req.name,
    ext: type,
    bytes: req.bytes,
    partBytes: library.partBytes,
    parts,
    fingerprint: req.fingerprint,
    createdAt: now,
    expiresAt: now + LIBRARY_EXPIRY_MS,
    idemKey: req.idemKey,
  };
  let refused: Awaited<ReturnType<typeof reserveLibrary>>;
  try {
    refused = await reserveLibrary(d.db, row, limits);
  } catch {
    return no("internal");
  }
  if (refused) {
    if (refused === "twin") return (await resume(d, owner, req)) ?? no("bad_request");
    return no(refused);
  }
  const release = () => releaseLibrary(d.db, { id: row.id, userId, bytes: req.bytes }, d.now());

  const bytesTake = await d.spend.take("upload_user_bytes", req.bytes, userId);
  if (!bytesTake.ok) {
    await release();
    return spendFailure(bytesTake);
  }
  const countTake = await d.spend.take("upload_user", 1, userId);
  if (!countTake.ok) {
    await d.spend.refund(bytesTake.ticket);
    await release();
    return spendFailure(countTake);
  }
  const undo = async () => {
    await d.spend.refund(bytesTake.ticket);
    await d.spend.refund(countTake.ticket);
    await release();
  };

  const classA = await d.spend.charge("A", 1);
  if (!classA.ok) {
    await undo();
    return spendFailure(classA);
  }
  let r2UploadId: string;
  try {
    r2UploadId = await d.mp.create(key);
  } catch {
    await undo();
    return no("internal");
  }
  if (!(await store.setUploadId(d.db, row.id, r2UploadId))) {
    await d.mp.abort(key, r2UploadId);
    await undo();
    return no("upload_gone");
  }
  const created = await store.get(d.db, row.id);
  if (!created) return no("internal");
  const answer = await answerFor(d, created);
  return answer.ok ? yes({ created: true, answer: answer.value }) : answer;
}

/** The open upload of the same file, answered as it stands. A row of another name or size is not this file. */
async function resume(
  d: Deps,
  owner: store.Owner,
  req: CreateRequest,
): Promise<Out<{ created: boolean; answer: CreateAnswer }> | null> {
  const found = await store.findOpen(d.db, owner, req.fingerprint, d.now());
  if (!found || found.bytes !== req.bytes || found.name !== req.name) return null;
  if (found.r2UploadId === "") return no("upload_busy");
  const answer = await answerFor(d, found);
  return answer.ok ? yes({ created: false, answer: answer.value }) : answer;
}

// ---- parts ----

/** URLs for the given pending parts: the Worker's own path in proxy mode, presigned R2 URLs in direct mode. */
export async function mint(d: Deps, row: store.UploadRow, parts: number[]): Promise<Out<PartUrl[]>> {
  if (parts.length === 0) return yes([]);
  if (!d.presigner || d.config.library.uploadMode === "proxy") {
    return yes(parts.map((n) => ({ n, url: `/api/uploads/${row.id}/parts/${n}` })));
  }
  if (!(await store.chargeMints(d.db, row.id, parts.length))) return no("rate_limited");
  const classA = await d.spend.charge("A", parts.length);
  if (!classA.ok) return spendFailure(classA);
  const signer = d.presigner;
  return yes(
    await Promise.all(
      parts.map(async (n) => ({
        n,
        ...(await signer.part(row, n, partSize(row, n))),
      })),
    ),
  );
}

/** The parts a client asks URLs for, minus those already stored (a done part is never minted again). */
export async function urlsFor(d: Deps, row: store.UploadRow, wanted: number[]): Promise<Out<PartUrl[]>> {
  if (!store.isOpen(row)) return no("upload_gone");
  if (wanted.some((n) => !validPart(row, n))) return no("bad_request");
  const done = new Set((await store.doneParts(d.db, row.id)).map((p) => p.n));
  return mint(
    d,
    row,
    wanted.filter((n) => !done.has(n)),
  );
}

/** One part through the Worker: the body is exactly the part's size, stored in R2, recorded with R2's ETag. */
export async function putPart(
  d: Deps,
  row: store.UploadRow,
  n: number,
  body: ReadableStream<Uint8Array>,
  length: number,
): Promise<Out<{ n: number; etag: string }>> {
  if (!store.isOpen(row)) return no("upload_gone");
  if (!validPart(row, n) || length !== partSize(row, n)) return no("bad_request");
  const classA = await d.spend.charge("A", 1);
  if (!classA.ok) return spendFailure(classA);
  let etag: string;
  try {
    etag = cleanEtag(await d.mp.part(row.r2Key, row.r2UploadId, n, body, length));
  } catch {
    return no("upload_aborted");
  }
  if (!(await store.recordPart(d.db, row.id, n, etag, length, d.now()))) return no("upload_gone");
  return yes({ n, etag });
}

/** A direct part's confirmation: the client reports the ETag R2 returned, and the size must be the part's. */
export async function confirmPart(
  d: Deps,
  row: store.UploadRow,
  n: number,
  etag: string,
  bytes: number,
): Promise<Out<{ n: number; confirmed: number; total: number }>> {
  if (!store.isOpen(row)) return no("upload_gone");
  if (!validPart(row, n) || bytes !== partSize(row, n)) return no("bad_request");
  if (!(await store.recordPart(d.db, row.id, n, cleanEtag(etag), bytes, d.now()))) return no("upload_gone");
  return yes({
    n,
    confirmed: (await store.doneParts(d.db, row.id)).length,
    total: row.parts,
  });
}

// ---- complete ----

const fileState = async (d: Deps, row: store.UploadRow): Promise<FileState | null> => {
  const file = await d.db
    .prepare("SELECT id, status, refusal FROM library_file WHERE id = ? AND user_id = ?")
    .bind(row.fileId, row.userId)
    .first<{
      id: string;
      status: FileState["status"];
      refusal: string | null;
    }>();
  return file
    ? {
        id: file.id,
        status: file.status,
        ...(file.refusal ? { refusal: file.refusal } : {}),
      }
    : null;
};

const answerOf = (file: FileState): CompleteAnswer => ({
  state: file.status,
  file,
});

/**
 * Joins the parts and settles the quota under the claim, then checks the stored file. `last` is the final part's
 * confirmation riding on complete (O5); the part list itself always comes from D1 (UP-08).
 */
export async function completeLibrary(
  d: Deps,
  row: store.UploadRow,
  last?: { n: number; etag: string; bytes: number },
): Promise<Out<CompleteAnswer>> {
  const now = d.now();
  if (!(await store.claim(d.db, row.id, now))) {
    const current = await store.get(d.db, row.id);
    if (current?.completedAt != null) return settledAnswer(d, current);
    return no(current && store.isOpen(current) ? "upload_busy" : "upload_gone");
  }
  const owned = {
    id: row.id,
    userId: row.userId as string,
    fileId: row.fileId,
    bytes: row.bytes,
  };
  const give = async (error: ErrorCode | AppError, deleteObject = true) => {
    if (deleteObject) await d.mp.delete(row.r2Key).catch(() => {});
    await d.mp.abort(row.r2Key, row.r2UploadId);
    await releaseLibrary(d.db, owned, d.now(), now);
    return no(error);
  };

  if (last) {
    if (!validPart(row, last.n) || last.bytes !== partSize(row, last.n)) return give("bad_request", false);
    await store.recordPart(d.db, row.id, last.n, cleanEtag(last.etag), last.bytes, now);
  }
  const done = await store.doneParts(d.db, row.id);
  const whole = done.length === row.parts && done.every((p, i) => p.n === i + 1 && p.bytes === partSize(row, p.n));
  if (!whole) {
    // Not a failure of the upload: the client re-reads its state and sends the gaps. Give the claim back.
    await store.unclaim(d.db, row.id, now);
    return no("bad_request");
  }
  const classA = await d.spend.charge("A", 1);
  if (!classA.ok) {
    await store.unclaim(d.db, row.id, now);
    return spendFailure(classA);
  }
  try {
    await d.mp.complete(
      row.r2Key,
      row.r2UploadId,
      done.map((p) => ({ n: p.n, etag: p.etag })),
    );
  } catch {
    return give("size_mismatch");
  }
  const head = await d.mp.head(row.r2Key);
  if (!head || head.size !== row.bytes) return give("too_large");
  return settleAndCheck(d, row, now);
}

/** After R2's complete: the settle batch under the claim, then the check. Also the sweep's way to finish a crash. */
export async function settleAndCheck(d: Deps, row: store.UploadRow, claimToken: number): Promise<Out<CompleteAnswer>> {
  const owned = {
    id: row.id,
    userId: row.userId as string,
    fileId: row.fileId,
    bytes: row.bytes,
  };
  if (!(await settleLibrary(d.db, owned, claimToken, d.now()))) {
    await d.mp.delete(row.r2Key).catch(() => {});
    await releaseLibrary(d.db, owned, d.now(), claimToken);
    return no("upload_gone");
  }
  return checkFile(d, row);
}

/** The check of a `checking` library file: ready, refused, or still checking when it could not be decided now. */
export async function checkFile(d: Deps, row: store.UploadRow): Promise<Out<CompleteAnswer>> {
  const userId = row.userId as string;
  const file = { id: row.fileId, userId, bytes: row.bytes };
  const now = d.now();
  const checked = await checkStored(d.mp, row.r2Key, row.bytes, row.ext as FormatType, {
    deadline: now + CHECK_WALL_MS,
    now: d.now,
    charge: async (n) => (await d.spend.charge("B", n)).ok,
  });
  if (checked.ok === "later")
    return yes({
      state: "checking",
      file: { id: row.fileId, status: "checking" },
    });
  if (!checked.ok) {
    await d.mp.delete(row.r2Key).catch(() => {});
    await refuseLibrary(d.db, file, checked.error, d.now());
    return yes({
      state: "refused",
      file: { id: row.fileId, status: "refused", refusal: checked.error },
    });
  }
  await markReady(d.db, file, { sha256: checked.sha256, crc32: checked.crc32, ext: checked.type }, d.now());
  await d.afterReady?.({ id: row.fileId, userId, ext: checked.type });
  return yes({ state: "ready", file: { id: row.fileId, status: "ready" } });
}

/** The outcome of a complete that already settled; a check a crash left `checking` is run again after the claim window. */
async function settledAnswer(d: Deps, row: store.UploadRow): Promise<Out<CompleteAnswer>> {
  const state = await fileState(d, row);
  if (!state) return no("upload_gone");
  if (
    state.status === "checking" &&
    (await claimCheck(d.db, { id: row.fileId, userId: row.userId as string }, d.now()))
  ) {
    return checkFile(d, row);
  }
  return yes(answerOf(state));
}

// ---- abort and read back ----

/** Cancels an upload: R2's multipart is aborted and the reservation returns. Idempotent; a fresh complete claim refuses it. */
export async function abortLibrary(d: Deps, row: store.UploadRow): Promise<Out<null>> {
  if (!store.isOpen(row)) return yes(null);
  const owned = { id: row.id, userId: row.userId as string, bytes: row.bytes };
  if (!(await releaseLibrary(d.db, owned, d.now()))) return no("upload_busy");
  await d.mp.abort(row.r2Key, row.r2UploadId);
  return yes(null);
}

export interface UploadState {
  id: string;
  name: string;
  bytes: number;
  partBytes: number;
  parts: number;
  done: number[];
  state: "open" | "completing" | "completed" | "aborted";
  file?: FileState;
}

export async function stateOf(d: Deps, row: store.UploadRow): Promise<UploadState> {
  const done = (await store.doneParts(d.db, row.id)).map((p) => p.n);
  const state =
    row.abortedAt !== null
      ? "aborted"
      : row.completedAt !== null
        ? "completed"
        : row.completingAt !== null && d.now() - row.completingAt < store.CLAIM_MS
          ? "completing"
          : "open";
  const settled = state === "completed" ? await settledAnswer(d, row) : null;
  const file = settled?.ok ? settled.value.file : null;
  return {
    id: row.id,
    name: row.name,
    bytes: row.bytes,
    partBytes: row.partBytes,
    parts: row.parts,
    done,
    state,
    ...(file ? { file } : {}),
  };
}
