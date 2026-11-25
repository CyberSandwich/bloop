// The limits on concurrent demo sessions (threat model DEMO-02), kept in the Directory beside the codes: a global
// cap, and a per-IP-hash cap so one address cannot fill it. A slot is held until its session ends, its screen
// closes or its hold runs out, so a screen that never closes cannot pin one.

/** The slice of `ctx.storage.sql` used here, so unit tests can run it over node:sqlite. */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}

/** Over the `demo` table, which `initDirectoryStorage` (do/directory-schema.ts) creates. */
export class DemoSlots {
  constructor(private readonly sql: SqlLike) {}

  /**
   * Holds a slot for `holdMs`, or refuses with false when `cap` live slots are taken or this IP hash already
   * holds `perIp`. A held ref only renews.
   */
  reserve(screenRef: string, ipHash: string, now: number, holdMs: number, cap: number, perIp: number): boolean {
    this.prune(now);
    if (!this.held(screenRef) && (this.count() >= cap || this.countFor(ipHash) >= perIp)) return false;
    this.sql.exec(
      "INSERT OR REPLACE INTO demo (screen_ref, ip_hash, expires_at) VALUES (?, ?, ?)",
      screenRef,
      ipHash,
      now + holdMs,
    );
    return true;
  }

  release(screenRef: string): void {
    this.sql.exec("DELETE FROM demo WHERE screen_ref = ?", screenRef);
  }

  prune(now: number): void {
    this.sql.exec("DELETE FROM demo WHERE expires_at <= ?", now);
  }

  count(): number {
    return Number(this.sql.exec("SELECT count(*) AS n FROM demo").toArray()[0]?.n ?? 0);
  }

  private countFor(ipHash: string): number {
    return Number(this.sql.exec("SELECT count(*) AS n FROM demo WHERE ip_hash = ?", ipHash).toArray()[0]?.n ?? 0);
  }

  private held(screenRef: string): boolean {
    return this.sql.exec("SELECT 1 AS one FROM demo WHERE screen_ref = ?", screenRef).toArray().length > 0;
  }
}
