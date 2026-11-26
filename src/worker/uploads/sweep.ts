// The upload sweeps (ADR 0017): hourly, finish or release what a crash left, settle a check left `checking`, and start
// the conversion of ready files that have none (never while CONVERT_MODE is off); nightly, heal the quota counters. Each row is taken under the claim rule of store.ts, so a sweep never races a live
// complete or abort, and each row's failure is logged and skipped, so one bad row never stops the run.
import type { BatchDb } from "../auth/db.ts";
import { checkFile, type Deps, settleAndCheck } from "./pipeline.ts";
import {
  type CheckingFile,
  claimCheck,
  type Drift,
  reconcileUser,
  refuseLibrary,
  releaseLibrary,
  staleChecking,
  strandedKeys,
  unconverted,
} from "./quota.ts";
import { reclaim } from "./reclaim.ts";
import * as store from "./store.ts";

/** Closed upload rows are kept this long (the idempotent replay and the status read), then deleted. */
const CLOSED_KEEP_MS = 86_400_000;
/** A file still `checking` this long after it settled is refused (`service_busy`): its check can no longer be trusted to finish. */
const CHECK_GIVE_UP_MS = 86_400_000;
/** The wall time one hourly run may spend before it leaves the rest to the next (a check alone may take 90 s). */
export const SWEEP_WALL_MS = 240_000;
const PAGE = 100;

export interface SweepReport {
  finished: number;
  released: number;
  deleted: number;
  rechecked: number;
  refused: number;
  /** Ready files handed to the conversion start. */
  converted: number;
  /** The allotment or the wall-time budget stopped the run with work left. */
  more: boolean;
}

type Counted = "finished" | "released" | "rechecked" | "refused" | "converted";

/** Closes one open upload and returns what it held: the reservation (library), the multipart and any object. */
const giveUp = (d: Deps, row: store.UploadRow, claimToken = -1): Promise<boolean> =>
  reclaim(d.mp, row, () =>
    row.ownerKind === "library"
      ? releaseLibrary(d.db, { id: row.id, userId: row.userId as string, bytes: row.bytes }, d.now(), claimToken)
      : store.closeGuest(d.db, row.id, d.now(), claimToken),
  );

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

/** A file a check left `checking`: checked again, or refused once it is past the give-up age. */
async function recheck(d: Deps, f: CheckingFile): Promise<"rechecked" | "refused" | "skipped"> {
  if (!(await claimCheck(d.db, f, d.now()))) return "skipped";
  if (d.now() - f.createdAt < CHECK_GIVE_UP_MS) {
    await checkFile(d, f);
    return "rechecked";
  }
  return (await reclaim(d.mp, { r2Key: f.r2Key }, () => refuseLibrary(d.db, f, "service_busy", d.now())))
    ? "refused"
    : "skipped";
}

/** Deletes objects a crash stranded between a won release or refusal and its delete (see reclaim.ts). */
async function strandStep(d: Deps, allotment: number, report: SweepReport, start: number): Promise<void> {
  const keys = await strandedKeys(d.db, d.now() - CLOSED_KEEP_MS, allotment);
  for (const key of keys) {
    if (d.now() - start >= SWEEP_WALL_MS) {
      report.more = true;
      return;
    }
    await d.mp.delete(key).catch(() => console.error(JSON.stringify({ evt: "upload_sweep_failed", step: "stranded" })));
  }
}

/**
 * Hourly. At most `allotment` rows of each kind (stale completes, uploads nobody can finish, files left checking),
 * within `SWEEP_WALL_MS`; closed rows past the keep window go too. A row that throws is logged by id and skipped.
 */
export async function sweepUploads(d: Deps, allotment: number): Promise<SweepReport> {
  const report: SweepReport = {
    finished: 0,
    released: 0,
    deleted: 0,
    rechecked: 0,
    refused: 0,
    converted: 0,
    more: false,
  };
  const start = d.now();
  const each = async <T extends { id: string }>(
    step: string,
    rows: T[],
    run: (row: T) => Promise<Counted | "skipped">,
  ): Promise<void> => {
    if (rows.length >= allotment) report.more = true;
    for (const row of rows) {
      if (d.now() - start >= SWEEP_WALL_MS) {
        report.more = true;
        return;
      }
      try {
        const outcome = await run(row);
        if (outcome !== "skipped") report[outcome] += 1;
      } catch {
        // The id only: an error's message can carry a key or a name.
        console.error(JSON.stringify({ evt: "upload_sweep_failed", step, id: row.id }));
      }
    }
  };
  await each("stale_complete", await store.staleCompletes(d.db, d.now(), allotment), (row) => recover(d, row));
  await each("expired", await store.expiredOpen(d.db, d.now(), allotment), async (row) =>
    (await giveUp(d, row)) ? "released" : "skipped",
  );
  await each("checking", await staleChecking(d.db, d.now(), allotment), (f) => recheck(d, f));
  const convert = d.afterReady;
  if (convert && d.config.library.convertMode !== "off") {
    await each("convert", await unconverted(d.db, allotment), async (f) => {
      await convert(f);
      return "converted";
    });
  }
  await strandStep(d, allotment, report, start);
  report.deleted = await store.deleteClosed(d.db, d.now() - CLOSED_KEEP_MS, allotment);
  if (report.deleted >= allotment) report.more = true;
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
