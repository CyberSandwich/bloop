// The upload sweeps (ADR 0017): hourly, finish or release what a crash left; nightly, heal the quota counters.
// Each row is taken under the claim rule of store.ts, so a sweep never races a live complete or abort.
import type { BatchDb } from "../auth/db.ts";
import { type Deps, settleAndCheck } from "./pipeline.ts";
import { type Drift, reconcileUser, releaseLibrary } from "./quota.ts";
import * as store from "./store.ts";

/** Closed upload rows are kept this long (the idempotent replay and the status read), then deleted. */
const CLOSED_KEEP_MS = 86_400_000;
const PAGE = 100;

export interface SweepReport {
  finished: number;
  released: number;
  deleted: number;
}

/** Closes one open upload and returns what it held: the reservation (library), the multipart and any object. */
async function giveUp(d: Deps, row: store.UploadRow, claimToken = -1): Promise<boolean> {
  const closed =
    row.ownerKind === "library"
      ? await releaseLibrary(d.db, { id: row.id, userId: row.userId as string, bytes: row.bytes }, d.now(), claimToken)
      : await store.closeGuest(d.db, row.id, d.now(), claimToken);
  if (!closed) return false;
  await d.mp.abort(row.r2Key, row.r2UploadId);
  await d.mp.delete(row.r2Key).catch(() => {});
  return true;
}

/** A complete that died after its claim: the object is whole (settle and check) or it is not (release). */
async function recover(d: Deps, row: store.UploadRow): Promise<"finished" | "released" | "skipped"> {
  const token = d.now();
  if (!(await store.claim(d.db, row.id, token))) return "skipped";
  const head = await d.mp.head(row.r2Key);
  if (row.ownerKind === "library" && head && head.size === row.bytes) {
    await settleAndCheck(d, row, token);
    return "finished";
  }
  return (await giveUp(d, row, token)) ? "released" : "skipped";
}

/** Hourly. At most `allotment` stale completes and as many expired opens; closed rows past the keep window go too. */
export async function sweepUploads(d: Deps, allotment: number): Promise<SweepReport> {
  const report: SweepReport = { finished: 0, released: 0, deleted: 0 };
  for (const row of await store.staleCompletes(d.db, d.now(), allotment)) {
    const outcome = await recover(d, row);
    if (outcome === "finished") report.finished += 1;
    if (outcome === "released") report.released += 1;
  }
  for (const row of await store.expiredOpen(d.db, d.now(), allotment)) {
    if (await giveUp(d, row)) report.released += 1;
  }
  report.deleted = await store.deleteClosed(d.db, d.now() - CLOSED_KEEP_MS, allotment);
  return report;
}

/** Nightly. Recomputes every user's counters from the rows, up to `allotment` users a run, and returns the drifts found. */
export async function reconcileQuotas(db: BatchDb, allotment: number): Promise<{ drifts: Drift[]; more: boolean }> {
  const drifts: Drift[] = [];
  let after = "";
  for (let seen = 0; seen < allotment; ) {
    const limit = Math.min(PAGE, allotment - seen);
    const { results } = await db
      .prepare("SELECT id FROM app_user WHERE id > ? ORDER BY id LIMIT ?")
      .bind(after, limit)
      .all<{ id: string }>();
    for (const { id } of results) {
      const drift = await reconcileUser(db, id);
      if (drift) drifts.push(drift);
    }
    seen += results.length;
    if (results.length < limit) return { drifts, more: false };
    after = results[results.length - 1]?.id ?? after;
  }
  return { drifts, more: true };
}
