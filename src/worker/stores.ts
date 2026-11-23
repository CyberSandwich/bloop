// The one place the Worker picks its AuditLog and Metrics implementations (docs/interfaces.md section 7).
import type { AuditLog } from "./audit.ts";
import { D1AuditLog } from "./audit-d1.ts";
import { dbOf } from "./auth/db.ts";
import { configFor } from "./config.ts";
import type { Env } from "./env.ts";
import type { Metrics } from "./metrics.ts";
import { D1Metrics } from "./metrics-d1.ts";

export const auditFor = (env: Env): AuditLog => new D1AuditLog(dbOf(env.DB));

export function metricsFor(env: Env): Metrics {
  const config = configFor(env);
  return new D1Metrics(dbOf(env.DB), config.ok ? config.config.hashPepper : null);
}
