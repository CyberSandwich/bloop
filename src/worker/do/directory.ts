// The one Directory object (ADR 0002): typed code to screen routing, and exact per-IP-hash miss counts.
// Single-threaded, so a count and the refusal that follows it cannot race.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { CodeDirectory, DemoCap } from "../seams/pairing.ts";
import { DemoSlots } from "./demo-slots.ts";
import { isBlocked, MISS_WINDOW_MS, type MissRow, recordGlobalMiss, recordMiss } from "./directory-rules.ts";

/**
 * An expired code keeps routing to its screen for this long, so the Screen answers `code_expired`
 * (not `code_unknown`, which would count as a guess against the phone's IP hash).
 */
const GRAVE_MS = 5 * 60 * 1000;
const SWEEP_MS = 80_000;
/** The global miss counter shares the `miss` table; an IP hash is hex, so this key cannot collide with one. */
const GLOBAL_KEY = "global";

export class Directory extends DurableObject<Env> implements CodeDirectory, DemoCap {
  private readonly slots: DemoSlots;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.slots = new DemoSlots(ctx.storage.sql);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS code (code TEXT PRIMARY KEY, screen_ref TEXT NOT NULL, expires_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE IF NOT EXISTS miss (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);`,
    );
  }

  async put(code: string, screenRef: string, expiresAt: number, demo: boolean): Promise<"ok" | "collision"> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM code WHERE expires_at <= ?", now - GRAVE_MS);
    const held = sql
      .exec<{ screen_ref: string; expires_at: number }>("SELECT screen_ref, expires_at FROM code WHERE code = ?", code)
      .toArray()[0];
    if (held && held.screen_ref !== screenRef && held.expires_at > now) return "collision";
    sql.exec(
      "INSERT OR REPLACE INTO code (code, screen_ref, expires_at, demo) VALUES (?, ?, ?, ?)",
      code,
      screenRef,
      expiresAt,
      demo ? 1 : 0,
    );
    await this.armSweep();
    return "ok";
  }

  async lookup(
    code: string,
    ipHash: string,
    now: number,
  ): Promise<{ ok: true; screenRef: string; demo: boolean } | { ok: false; error: "code_unknown" | "rate_limited" }> {
    const sql = this.ctx.storage.sql;
    const misses = this.missRow(ipHash);
    if (isBlocked(misses, now)) return { ok: false, error: "rate_limited" };

    const hit = sql
      .exec<{ screen_ref: string; demo: number }>("SELECT screen_ref, demo FROM code WHERE code = ?", code)
      .toArray()[0];
    if (hit) return { ok: true, screenRef: hit.screen_ref, demo: hit.demo === 1 };

    this.saveMiss(ipHash, recordMiss(misses, now));
    const global = recordGlobalMiss(this.missRow(GLOBAL_KEY), now);
    this.saveMiss(GLOBAL_KEY, global.row);
    if (global.alarm) console.warn(JSON.stringify({ evt: "pair.miss_alarm", misses: global.row.count }));
    await this.armSweep();
    return { ok: false, error: "code_unknown" };
  }

  async demoReserve(screenRef: string, ipHash: string, holdMs: number, cap: number, perIp: number): Promise<boolean> {
    return this.slots.reserve(screenRef, ipHash, Date.now(), holdMs, cap, perIp);
  }

  async demoRelease(screenRef: string): Promise<void> {
    this.slots.release(screenRef);
  }

  async remove(code: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM code WHERE code = ?", code);
  }

  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM code WHERE expires_at <= ?", now - GRAVE_MS);
    sql.exec("DELETE FROM miss WHERE window_start <= ?", now - MISS_WINDOW_MS);
    this.slots.prune(now);
    const left = sql
      .exec<{ n: number }>(
        "SELECT (SELECT count(*) FROM code) + (SELECT count(*) FROM miss) + (SELECT count(*) FROM demo) AS n",
      )
      .one();
    if (left.n > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  private missRow(key: string): MissRow | null {
    const row = this.ctx.storage.sql
      .exec<{ count: number; window_start: number }>("SELECT count, window_start FROM miss WHERE ip_hash = ?", key)
      .toArray()[0];
    return row ? { count: row.count, windowStart: row.window_start } : null;
  }

  private saveMiss(key: string, row: MissRow): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO miss (ip_hash, count, window_start) VALUES (?, ?, ?)",
      key,
      row.count,
      row.windowStart,
    );
  }

  private async armSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }
}
