// A guest's upload on the shared pipeline (docs/uploads.md section 7): a guest's create, complete and cancel differ from
// the library's only in what they move. Parts, URLs and the read are pipeline.ts's. A guest has no quota: the
// session's caps (store.insertGuest) and the guest storage budget (GuestDrop.reserve) stand in, and a guest file never
// waits `checking`: one that cannot be checked now is refused `service_busy`, which the phone may send again. Every R2
// operation counts twice: on the spend guard, as the library's do, and on the guest meter (DROP-05), whose cap is
// `storage_full`.
import { typeOfName } from "../../../public/js/shared/names.js";
import type { AppError, ErrorCode, FileType } from "../../shared/protocol.ts";
import { newRef } from "../ids.ts";
import { dropError } from "../seams/guest-drop/formats.ts";
import { newGuestKey, QuotaExhausted, type SettledFile } from "../seams/guest-drop/index.ts";
import type { OpClass } from "../seams/guest-drop/meter.ts";
import { checkStored } from "./check.ts";
import {
  answerFor,
  type CompleteAnswer,
  type Created,
  type CreateRequest,
  type Deps,
  joinParts,
  mpOf,
  no,
  type Out,
  putPart,
  resume,
  spendFailure,
  yes,
} from "./pipeline.ts";
import { reclaim } from "./reclaim.ts";
import * as store from "./store.ts";

/** The check ends this long after complete's claim, as the library's does. */
const CHECK_WALL_MS = 90_000;
/** Guest uploads a session may hold open at once; the phone queues the rest. */
export const GUEST_MAX_OPEN = 3;

export interface GuestLimits extends store.GuestCaps {
  /** The screen's cap on one guest file (GUEST_MAX_BYTES, or the demo's). */
  maxBytes: number;
  /** How long an open guest upload lives: the session's upload window. */
  expiryMs: number;
}

/** What a guest upload moves outside the upload table: the storage budget, and the Screen once the file is ready. */
export interface GuestSide {
  sessionId: string;
  screenRef: string;
  /** Reserves the budget for the file before R2 is asked; the refusal, or null. */
  reserve(r2Key: string, bytes: number, name: string, type: FileType): Promise<ErrorCode | null>;
  /** The file is ready: the ledger keeps it and the Screen shows its item. False: the session ended meanwhile. */
  settle(file: SettledFile): Promise<boolean>;
  /** The file will not be: its ledger row closes and any object left goes (GuestDrop.purge). Never throws. */
  forget(r2Key: string): Promise<void>;
  /** Counts R2 operations on the guest meter (GuestDrop.charge); false at its cap. */
  charge(cls: OpClass, n: number): Promise<boolean>;
}

/**
 * The deps of a guest's request: each R2 charge counts on the guest meter first, and its cap throws QuotaExhausted,
 * which this file and the part route answer `storage_full`. The spend guard's own refusal is answered as the library's.
 */
export function meteredFor(d: Deps, side: Pick<GuestSide, "charge">): Deps {
  const charge: Deps["spend"]["charge"] = async (cls, n) => {
    if (!(await side.charge(cls, n))) throw new QuotaExhausted();
    return d.spend.charge(cls, n);
  };
  return { ...d, spend: { ...d.spend, charge } };
}

/** `op`'s answer, or `storage_full` when the guest meter refused one of its charges. */
async function unlessCapped<T>(op: () => Promise<T>): Promise<T | "storage_full"> {
  try {
    return await op();
  } catch (error) {
    if (error instanceof QuotaExhausted) return "storage_full";
    throw error;
  }
}

const ownerOf = (side: GuestSide): store.Owner => ({
  kind: "guest",
  sessionId: side.sessionId,
  screenRef: side.screenRef,
});

/** Opens a guest upload, or resumes the session's live one of the same file (UP-09). */
export async function createGuest(d: Deps, side: GuestSide, req: CreateRequest, limits: GuestLimits): Promise<Created> {
  const type = typeOfName(req.name);
  if (!type) return no("bad_type");
  if (req.bytes > limits.maxBytes) return no("too_large");
  const owner = ownerOf(side);
  const resumed = await resume(d, owner, req);
  if (resumed) return resumed;

  const { partBytes } = d.config.library;
  const now = d.now();
  const row: store.NewUpload = {
    id: newRef(),
    owner,
    fileId: newRef(),
    r2Key: newGuestKey(),
    r2UploadId: "",
    name: req.name,
    ext: type,
    bytes: req.bytes,
    partBytes,
    parts: Math.ceil(req.bytes / partBytes),
    fingerprint: req.fingerprint,
    createdAt: now,
    expiresAt: now + limits.expiryMs,
    idemKey: req.idemKey,
  };
  let refused: store.GuestRefusal | null;
  try {
    refused = await store.insertGuest(d.db, row, limits);
  } catch {
    // Two requests with one Idempotency-Key raced into its unique index: the winner's upload is the answer.
    return (await resume(d, owner, req)) ?? no("internal");
  }
  if (refused === "twin") return (await resume(d, owner, req)) ?? no("upload_busy");
  if (refused) return no(refused);
  const close = () => store.closeGuest(d.db, row.id, d.now());
  const undo = async (error: ErrorCode | AppError, out?: Out<never>): Promise<Out<never>> => {
    await close();
    await side.forget(row.r2Key);
    return out ?? no(error);
  };

  const budget = await side.reserve(row.r2Key, row.bytes, row.name, type);
  if (budget) {
    await close();
    return no(budget);
  }
  const classA = await unlessCapped(() => d.spend.charge("A", 1));
  if (classA === "storage_full") return undo(classA);
  if (!classA.ok) return undo("internal", spendFailure(classA));
  const mp = mpOf(d, { bucket: "guest" });
  let r2UploadId: string;
  try {
    r2UploadId = await mp.create(row.r2Key);
  } catch {
    return undo("internal");
  }
  if (!(await store.setUploadId(d.db, row.id, r2UploadId))) {
    // No row names this multipart (it was closed meanwhile), so the ordering rule has nothing to guard.
    await mp.abort(row.r2Key, r2UploadId);
    return undo("upload_gone");
  }
  const created = await store.get(d.db, row.id);
  if (!created) return no("internal");
  const answer = await answerFor(d, created);
  return answer.ok ? yes({ created: true, answer: answer.value }) : answer;
}

/** A guest upload completes only with a ready file, so a closed row answers by how it closed. */
async function closedAnswer(d: Deps, row: store.UploadRow): Promise<Out<CompleteAnswer>> {
  const now = await store.get(d.db, row.id);
  if (now?.completedAt != null) return yes({ state: "ready", file: { id: row.fileId, status: "ready" } });
  return no(now && store.isOpen(now) ? "upload_busy" : "upload_gone");
}

/**
 * Joins the parts under the claim, checks the stored object, and on a pass settles it (the ledger and the Screen) before
 * the row closes; any refusal closes the row first and then deletes (the ordering rule). `ready` answers once.
 */
export async function completeGuest(d: Deps, side: GuestSide, row: store.UploadRow): Promise<Out<CompleteAnswer>> {
  const now = d.now();
  if (!(await store.claim(d.db, row.id, now))) return closedAnswer(d, row);
  const mp = mpOf(d, row);
  const file = { id: row.fileId };
  /** Closes the row under this claim and deletes what it held; a loser answers the row as it stands. */
  const close = async (): Promise<boolean> => {
    const won = await reclaim(mp, row, () => store.closeGuest(d.db, row.id, d.now(), now));
    if (won) await side.forget(row.r2Key);
    return won;
  };
  const give = async (error: ErrorCode | AppError): Promise<Out<CompleteAnswer>> =>
    (await close()) ? no(error) : closedAnswer(d, row);
  const refuse = async (refusal: string): Promise<Out<CompleteAnswer>> =>
    (await close()) ? yes({ state: "refused", file: { ...file, status: "refused", refusal } }) : closedAnswer(d, row);

  const unjoined = await unlessCapped(() => joinParts(d, row, now, give));
  if (unjoined === "storage_full") return refuse(unjoined);
  if (unjoined) return unjoined;
  const checked = await unlessCapped(() =>
    checkStored(mp, row.r2Key, row.bytes, row.ext as FileType, {
      deadline: now + CHECK_WALL_MS,
      now: d.now,
      charge: async (n) => (await d.spend.charge("B", n)).ok,
    }),
  );
  if (checked === "storage_full") return refuse(checked);
  if (checked.ok !== true) return refuse(checked.ok === "later" ? "service_busy" : dropError(checked.error));
  const settled = await side.settle({
    uploadId: row.id,
    fileId: row.fileId,
    r2Key: row.r2Key,
    kind: checked.type as FileType,
    name: row.name,
    size: row.bytes,
    sha256: checked.sha256,
  });
  if (!settled) return give("upload_gone");
  if (!(await store.completeGuest(d.db, row.id, now, d.now()))) return closedAnswer(d, row);
  return yes({ state: "ready", file: { ...file, status: "ready" } });
}

/** A guest's part through the Worker; past the guest meter's cap the upload is cancelled and `storage_full` answered. */
export async function putGuestPart(
  d: Deps,
  side: Pick<GuestSide, "forget">,
  row: store.UploadRow,
  n: number,
  body: ReadableStream<Uint8Array>,
  length: number,
): Promise<Out<{ n: number; etag: string }>> {
  const out = await unlessCapped(() => putPart(d, row, n, body, length));
  if (out !== "storage_full") return out;
  await abortGuest(d, side, row);
  return no(out);
}

/** Cancels a guest upload: the row closes, then its multipart and any object go. Idempotent. */
export async function abortGuest(d: Deps, side: Pick<GuestSide, "forget">, row: store.UploadRow): Promise<Out<null>> {
  if (!store.isOpen(row)) return yes(null);
  if (await reclaim(mpOf(d, row), row, () => store.closeGuest(d.db, row.id, d.now()))) {
    await side.forget(row.r2Key);
    return yes(null);
  }
  const now = await store.get(d.db, row.id);
  return now && store.isOpen(now) ? no("upload_busy") : yes(null);
}

/**
 * A session's end: every open upload of it closes and its multipart and object go, before the session's files are
 * deleted, so no multipart outlives its session. A row under a live complete's claim is skipped: that complete's settle
 * then finds the session gone and deletes the object itself. Returns how many closed.
 */
export async function abortSession(d: Deps, sessionId: string): Promise<number> {
  let closed = 0;
  for (const row of await store.openOfSession(d.db, sessionId)) {
    if (await reclaim(mpOf(d, row), row, () => store.closeGuest(d.db, row.id, d.now()))) closed += 1;
  }
  return closed;
}
