// The */5 sweep: for each live row nobody has touched, ask its Converter what is going on. It re-arms a stopped alarm
// or ends an overdue run, and fails a row whose Converter has no record; it never queues anything.
import type { ConvertDeps } from "./deps-types.ts";
import { markFailed, settlePreview, staleRuns } from "./results.ts";

/** A live row is touched at least every minute (heartbeat) or every wait cycle (lease), so this is generous. */
export const STALE_AFTER_MS = 10 * 60_000;

export interface SweepResult {
  checked: number;
  lost: number;
  expired: number;
  rearmed: number;
}

export async function sweepConversions(deps: ConvertDeps): Promise<SweepResult> {
  const out: SweepResult = { checked: 0, lost: 0, expired: 0, rearmed: 0 };
  for (const run of await staleRuns(deps.db, deps.now() - STALE_AFTER_MS)) {
    out.checked++;
    try {
      const state = await deps.converter(run.fileId, run.version).check(run.runId);
      if (state === "lost") {
        out.lost++;
        // A ready720 row is playable: its 720p stands, so only the full encode is lost.
        if (!(await settlePreview(deps.db, run, deps.now()))) await markFailed(deps.db, run, "interrupted", deps.now());
      } else if (state === "expired") out.expired++;
      else if (state === "rearmed") out.rearmed++;
    } catch (e) {
      deps.log(JSON.stringify({ evt: "convert_sweep_error", error: e instanceof Error ? e.message : "unknown" }));
    }
  }
  return out;
}
