# ADR 0006: audit, metrics and retention

Status: proposed. The periods need the owner's confirmation (OD-5).

## Context
IT must be able to check every claim, so each session is audited, and the audit is exportable. The product is judged by time from scan to first open and by failures with their cause. Audit rows are personal data, and file names can be sensitive.

## Decision
- **Two stores with different jobs:**
  - `audit_event` is identified: who, which room, when, which file, actor, cause. It is for users and IT.
  - `metric_event` is anonymous: no user, no file name; mode, kind, room, metric, ms, cause. It is for product decisions.
- **Allowed audit detail keys only** (`AuditEvent.detail`). Never tokens, codes, URLs, IPs or Graph ids.
- **Metrics:**
  - `scan_to_open_ms` runs from claim to first accepted `/f/` fetch;
  - `approve_to_open_ms`;
  - `failure` with a `FailureCause`;
  - `fallback` with the mode;
  - `session_minutes`.
  - Week-3 return uses `metric_user_week` with `HMAC(HASH_PEPPER, user_id)`.
- **Retention defaults (config):**

| data | kept |
|---|---|
| audit and session rows | 180 days |
| demo audit and session rows | 7 days |
| metric events | 90 days, then rolled into `metric_daily` (counts and percentiles), kept 2 years |
| pseudonymous weekly rows | 120 days |
| grants | 30 days idle |
| phone sessions | 30 days idle, 90 absolute |
| guest passes | 24 h |
| guest file rows | 30 days after deletion |

- **Jobs:**
  - daily at 03:30 UTC: purge by period, roll up metrics, re-wrap DEKs, delete idle grants and expired sessions;
  - hourly: end stale sessions, sweep guest objects.
  - Each job is idempotent and bounded, at most 5,000 rows a run, looping until done.
- **User view:** `/api/me/audit`.
- **Erasure:** `DELETE /api/me` deletes the grant and sessions, then anonymizes the user's audit rows. It keeps the session, room and time, and drops the user id and file name.
- **IT export:** `GET /api/it/export?format=json|csv&from&to`, streamed, with CSV formula escaping. Every run is itself audited.
  - Auth at MVP is one `IT_EXPORT_TOKEN` (hash compare, rate-limited).
  - Entra app roles per org replace it when registered rooms ship.

## Consequences
- IT gets a verifiable trail without bloop keeping identities in analytics.
- One shared export token is a known limit (threat model SITE-07).
- Workers Logs carry no personal data, so they need no retention rule beyond the platform's own (threat-model section 10).
