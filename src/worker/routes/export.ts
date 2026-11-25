// GET /api/it/export: the audit rows (or the metrics aggregate) for a date range, as JSON or CSV (SITE-06,
// SITE-07). One bearer token, compared by hash; every run is itself an audit row.

import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { exportRange, metricRecord, metricsCsv } from "../export-format.ts";
import { bearer, fail } from "../http.ts";
import { safeEqual, sha256Hex } from "../ids.ts";
import { route } from "../router.ts";
import { auditFor, metricsFor } from "../stores.ts";
import { limited, withConfig } from "./common.ts";

const FORMATS = { csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8" } as const;

/** Hashing first makes the compare constant-length; `safeEqual` makes it constant-time. */
async function tokenMatches(request: Request, config: Config): Promise<boolean> {
  const presented = bearer(request);
  if (!presented || !config.itExportToken) return false;
  return safeEqual(await sha256Hex(presented), await sha256Hex(config.itExportToken));
}

async function exportData(request: Request, env: Env, config: Config): Promise<Response> {
  // The limit is per pseudonymous IP, ahead of the token check: a limit keyed by the token would not slow guessing.
  const refused = await limited(env, "RL_EXPORT", request, config);
  if (refused) return refused;
  if (!(await tokenMatches(request, config))) return fail("unauthorized");

  const q = new URL(request.url).searchParams;
  const format = q.get("format") ?? "json";
  const data = q.get("data") ?? "audit";
  const now = Date.now();
  const range = exportRange(q.get("from"), q.get("to"), now);
  if (!Object.hasOwn(FORMATS, format) || !["audit", "metrics"].includes(data) || !range) return fail("bad_request");
  const kind = format as keyof typeof FORMATS;

  // An export nobody can later see is worse than a failed one: the run is recorded first.
  try {
    await auditFor(env).record({
      sessionId: "export",
      at: now,
      actor: "it",
      type: "export.run",
      detail: { purpose: `${data}.${format}`, reason: range.label },
    });
  } catch {
    console.error("export_audit_failed");
    return fail("internal");
  }

  const headers = {
    "Content-Type": FORMATS[kind],
    "Content-Disposition": `attachment; filename="bloop-${data}-${range.fileLabel}.${format}"`,
  };
  if (data === "metrics") {
    const rows = await metricsFor(env).summary(range.from, range.to);
    const body = kind === "csv" ? metricsCsv(rows) : JSON.stringify(rows.map(metricRecord));
    return new Response(body, { headers });
  }
  const stream = await auditFor(env).export({ orgId: null, from: range.from, to: range.to, format: kind });
  return new Response(stream, { headers });
}

export const exportRoutes = [route(["GET"], "/api/it/export", "api", withConfig(exportData))];
