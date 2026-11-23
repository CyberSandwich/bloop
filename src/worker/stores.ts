// The one place the Worker picks its AuditLog and Metrics implementations. Both are no-op stubs until
// the D1-backed ones exist; swapping them is a change to these two lines (docs/interfaces.md section 7).
import { type AuditLog, noopAudit } from "./audit.ts";
import type { Env } from "./env.ts";
import { type Metrics, noopMetrics } from "./metrics.ts";

export const auditFor = (_env: Env): AuditLog => noopAudit;
export const metricsFor = (_env: Env): Metrics => noopMetrics;
