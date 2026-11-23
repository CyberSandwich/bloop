// AuditLog over D1: one `audit_event` row per event, and a `session` row the events update. File contents,
// tokens, codes and IPs have no column; `detail` keeps only the allowed keys (sanitizeDetail).
import { type AuditEvent, type AuditLog, type AuditQuery, type AuditRow, sanitizeDetail } from "./audit.ts";
import type { Db } from "./auth/db.ts";
import { auditCsvHeader, auditCsvLine, auditRecord } from "./export-format.ts";

const DAY_MS = 86_400_000;
const PAGE = 500;

interface RawRow {
  id: number;
  session_id: string;
  at: number;
  actor: AuditRow["actor"];
  type: AuditRow["type"];
  detail: string;
  mode: AuditRow["mode"];
  kind: AuditRow["kind"];
  room_name: string | null;
  user_email: string | null;
}

const SELECT = `SELECT a.id, a.session_id, a.at, a.actor, a.type, a.detail, s.mode, s.kind,
    r.name AS room_name, u.email AS user_email
  FROM audit_event a
  LEFT JOIN session s ON s.id = a.session_id
  LEFT JOIN room r ON r.id = s.room_id
  LEFT JOIN app_user u ON u.id = s.user_id`;

function toRow(raw: RawRow): AuditRow {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    at: raw.at,
    actor: raw.actor,
    type: raw.type,
    detail: JSON.parse(raw.detail) as AuditRow["detail"],
    mode: raw.mode,
    kind: raw.kind,
    roomName: raw.room_name,
    userEmail: raw.user_email,
  };
}

export class D1AuditLog implements AuditLog {
  constructor(private readonly db: Db) {}

  async record(e: AuditEvent): Promise<void> {
    const detail = sanitizeDetail(e.detail);
    const { session: ctx } = e;
    if (ctx) {
      // A demo session keeps no account. The user must exist, or the foreign key would drop the whole event.
      const user = ctx.mode === "demo" ? null : ctx.userId;
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO session (id, screen_ref, room_id, mode, kind, user_id, claimed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, (SELECT id FROM app_user WHERE id = ?6), ?7)`,
        )
        .bind(e.sessionId, ctx.screenRef, ctx.roomId, ctx.mode, ctx.kind, user, e.at)
        .run();
      if (e.type === "approved" && user) {
        await this.db
          .prepare("UPDATE session SET user_id = (SELECT id FROM app_user WHERE id = ?1) WHERE id = ?2")
          .bind(user, e.sessionId)
          .run();
      }
    }
    await this.db
      .prepare("INSERT INTO audit_event (session_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(e.sessionId, e.at, e.actor, e.type, JSON.stringify(detail))
      .run();
    await this.updateSession(e, detail);
  }

  /** Mirrors the event into the session row the export and the retention rules read. */
  private async updateSession(e: AuditEvent, detail: AuditEvent["detail"]): Promise<void> {
    const sql = (set: string) => `UPDATE session SET ${set} WHERE id = ?`;
    const run = (set: string, ...values: unknown[]) =>
      this.db
        .prepare(sql(set))
        .bind(...values, e.sessionId)
        .run();
    switch (e.type) {
      case "approved":
        await run("approved_at = ?, file_name = ?, source = ?", e.at, detail.fileName ?? null, detail.source ?? null);
        break;
      case "guest.uploaded":
        await run("file_name = ?, source = ?", detail.fileName ?? null, detail.source ?? null);
        break;
      case "link.fetched":
        await run("first_open_at = COALESCE(first_open_at, ?), open_mode = ?", e.at, detail.purpose ?? null);
        break;
      case "ended":
      case "canceled":
        await run("ended_at = ?, end_reason = ?", e.at, detail.reason ?? null);
        break;
    }
  }

  async forUser(userId: string, limit: number, before?: number): Promise<AuditRow[]> {
    const { results } = await this.db
      .prepare(`${SELECT} WHERE s.user_id = ?1 AND a.at < ?2 ORDER BY a.at DESC, a.id DESC LIMIT ?3`)
      .bind(userId, before ?? Number.MAX_SAFE_INTEGER, limit)
      .all<RawRow>();
    return results.map(toRow);
  }

  async export(q: AuditQuery): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const csv = q.format === "csv";
    let lastId = 0;
    let started = false;
    let written = false;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const { results } = await this.db
          .prepare(
            `${SELECT} WHERE a.id > ?1 AND a.at >= ?2 AND a.at < ?3 AND (?4 IS NULL OR r.org_id = ?4)
             ORDER BY a.id LIMIT ?5`,
          )
          .bind(lastId, q.from, q.to, q.orgId, PAGE)
          .all<RawRow>();
        const rows = results.map(toRow);
        let text = started ? "" : csv ? auditCsvHeader() : "[";
        started = true;
        for (const row of rows) {
          text += csv ? auditCsvLine(row) : `${written ? "," : ""}${JSON.stringify(auditRecord(row))}`;
          written = true;
        }
        const last = rows.at(-1);
        if (last) lastId = last.id;
        const done = rows.length < PAGE;
        if (done && !csv) text += "]";
        controller.enqueue(encoder.encode(text));
        if (done) controller.close();
      },
    });
  }

  async purge(now: number, retention: { liveDays: number; demoDays: number }): Promise<number> {
    const live = now - retention.liveDays * DAY_MS;
    const demo = now - retention.demoDays * DAY_MS;
    const events = await this.db
      .prepare(
        `DELETE FROM audit_event WHERE at < ?1
           OR (at < ?2 AND session_id IN (SELECT id FROM session WHERE mode = 'demo'))`,
      )
      .bind(live, demo)
      .run();
    const sessions = await this.db
      .prepare("DELETE FROM session WHERE (mode = 'live' AND claimed_at < ?1) OR (mode = 'demo' AND claimed_at < ?2)")
      .bind(live, demo)
      .run();
    return events.meta.changes + sessions.meta.changes;
  }

  async anonymizeUser(userId: string): Promise<number> {
    // Detail first: once user_id is cleared the sessions can no longer be found.
    await this.db
      .prepare(
        `UPDATE audit_event SET detail = json_remove(detail, '$.fileName')
         WHERE session_id IN (SELECT id FROM session WHERE user_id = ?)`,
      )
      .bind(userId)
      .run();
    const sessions = await this.db
      .prepare("UPDATE session SET user_id = NULL, file_name = NULL WHERE user_id = ?")
      .bind(userId)
      .run();
    return sessions.meta.changes;
  }
}
