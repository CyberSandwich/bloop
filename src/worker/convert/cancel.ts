// Ends a version's live conversion: trash, purge, disable, a guest's end. The row first (so nothing new publishes), then
// the Converter (so the container dies and the lease frees). Idempotent; a Converter that cannot be reached is left to
// its deadline and the sweep, and its writes are already refused by the row.
import type { ConvertDeps } from "./deps-types.ts";
import { markCancelled } from "./results.ts";

export async function cancelConversion(
  deps: ConvertDeps,
  fileId: string,
  version: number,
  reason: string,
): Promise<void> {
  const runId = await markCancelled(deps.db, fileId, version, deps.now());
  if (!runId) return;
  try {
    await deps.converter(fileId, version).cancel(runId);
  } catch (e) {
    deps.log(
      JSON.stringify({ evt: "convert_cancel_failed", reason, error: e instanceof Error ? e.message : "unknown" }),
    );
  }
}
