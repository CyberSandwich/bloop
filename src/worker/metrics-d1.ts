// Metrics over D1: `metric_event` rows hold no user and no file name; the weekly-active table holds only an
// HMAC pseudonym (architecture 8.1).
import type { Db } from "./auth/db.ts";
import { hmacHex } from "./ids.ts";
import {
  dayOf,
  dayStart,
  isoWeek,
  type MetricEvent,
  type MetricRow,
  type MetricSummary,
  type Metrics,
  summarize,
} from "./metrics.ts";

const DAY_MS = 86_400_000;
/** Fixed by the retention table (threat-model section 10). */
const DAILY_KEEP_DAYS = 730;
const WEEK_KEEP_DAYS = 120;

export class D1Metrics implements Metrics {
  /** `pepper` is null when the configuration is invalid: events still record, pseudonyms do not. */
  constructor(
    private readonly db: Db,
    private readonly pepper: string | null,
  ) {}

  async record(e: MetricEvent): Promise<void> {
    await this.db
      .prepare("INSERT INTO metric_event (at, mode, kind, room_id, name, ms, cause) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(e.at, e.mode, e.kind, e.roomId, e.name, e.ms === undefined ? null : Math.round(e.ms), e.cause ?? null)
      .run();
  }

  async activeWeek(userId: string, now: number): Promise<void> {
    if (!this.pepper) return;
    const pseudonym = await hmacHex(this.pepper, userId);
    await this.db
      .prepare("INSERT OR IGNORE INTO metric_user_week (pseudonym, iso_week) VALUES (?, ?)")
      .bind(pseudonym, isoWeek(now))
      .run();
  }

  async summary(from: number, to: number): Promise<MetricSummary[]> {
    return summarize(await this.rows(from, to));
  }

  async rollup(day: string): Promise<void> {
    const start = Date.parse(`${day}T00:00:00Z`);
    for (const s of summarize(await this.rows(start, start + DAY_MS))) {
      await this.db
        .prepare(
          "INSERT OR REPLACE INTO metric_daily (day, mode, name, cause, n, p50_ms, p90_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(day, s.mode, s.name, s.cause, s.n, s.p50Ms, s.p90Ms)
        .run();
    }
  }

  async purge(now: number, days: number): Promise<number> {
    const cutoff = dayStart(now - days * DAY_MS);
    const { results } = await this.db
      .prepare("SELECT DISTINCT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day FROM metric_event WHERE at < ?")
      .bind(cutoff)
      .all<{ day: string }>();
    for (const { day } of results) await this.rollup(day);
    const deleted = await this.db.prepare("DELETE FROM metric_event WHERE at < ?").bind(cutoff).run();
    await this.db
      .prepare("DELETE FROM metric_daily WHERE day < ?")
      .bind(dayOf(now - DAILY_KEEP_DAYS * DAY_MS))
      .run();
    await this.db
      .prepare("DELETE FROM metric_user_week WHERE iso_week < ?")
      .bind(isoWeek(now - WEEK_KEEP_DAYS * DAY_MS))
      .run();
    return deleted.meta.changes;
  }

  private async rows(from: number, to: number): Promise<MetricRow[]> {
    const { results } = await this.db
      .prepare("SELECT mode, name, COALESCE(cause, '') AS cause, ms FROM metric_event WHERE at >= ? AND at < ?")
      .bind(from, to)
      .all<MetricRow>();
    return results;
  }
}
