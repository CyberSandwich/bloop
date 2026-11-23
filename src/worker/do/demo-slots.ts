// The global cap on concurrent demo sessions (threat model DEMO-02), kept in the Directory beside the codes.
// A slot is held until its screen closes or its hold runs out, so a screen that never closes cannot pin one.

/** The slice of `ctx.storage.sql` used here, so unit tests can run it over node:sqlite. */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}

export class DemoSlots {
  constructor(private readonly sql: SqlLike) {
    sql.exec("CREATE TABLE IF NOT EXISTS demo (screen_ref TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
  }

  /** Holds a slot for `holdMs`, or refuses with false when `cap` live slots are taken. A held ref only renews. */
  reserve(screenRef: string, now: number, holdMs: number, cap: number): boolean {
    this.prune(now);
    if (!this.held(screenRef) && this.count() >= cap) return false;
    this.sql.exec("INSERT OR REPLACE INTO demo (screen_ref, expires_at) VALUES (?, ?)", screenRef, now + holdMs);
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

  private held(screenRef: string): boolean {
    return this.sql.exec("SELECT 1 AS one FROM demo WHERE screen_ref = ?", screenRef).toArray().length > 0;
  }
}
