// Counts the R2 operations bloop performs so it never leaves R2's free tier (ADR 0005). Cloudflare has no
// spending cap on R2, so the cap is ours: each operation is counted in D1 before it runs, per UTC month.
// Class A (put, list) and class B (get, head) are the billed classes; delete is free and is never counted.
import type { Db } from "../../auth/db.ts";

export type OpClass = "A" | "B";
export interface OpCaps {
  classA: number;
  classB: number;
}

/** 50% of the free tier (1,000,000 class A and 10,000,000 class B): the billing period may not be the calendar month, and any 30 days span two. */
export const DEFAULT_OP_CAPS: OpCaps = { classA: 500_000, classB: 5_000_000 };

export class R2Meter {
  constructor(
    private readonly db: Db,
    private readonly caps: OpCaps,
    private readonly now: () => number,
  ) {}

  private month = () => new Date(this.now()).toISOString().slice(0, 7);
  private capOf = (cls: OpClass) => (cls === "A" ? this.caps.classA : this.caps.classB);

  /**
   * Counts `n` operations, atomically. False, with nothing counted, when they would pass the month's cap. Throws when
   * the counter cannot be written: callers must treat that as a refusal too (fail closed).
   */
  async charge(cls: OpClass, n = 1): Promise<boolean> {
    // Both WHEREs make a refused charge return no row, so the counter never passes the cap.
    const row = await this.db
      .prepare(
        `INSERT INTO r2_ops (month, class, n) SELECT ?1, ?2, ?4 WHERE ?4 <= ?3
         ON CONFLICT (month, class) DO UPDATE SET n = n + ?4 WHERE n + ?4 <= ?3
         RETURNING n`,
      )
      .bind(this.month(), cls, this.capOf(cls), n)
      .first<{ n: number }>();
    return row !== null;
  }

  /** True while both classes are below their caps this month. Counts nothing. */
  async hasRoom(): Promise<boolean> {
    const { results } = await this.db
      .prepare("SELECT class, n FROM r2_ops WHERE month = ?")
      .bind(this.month())
      .all<{ class: OpClass; n: number }>();
    return results.every((r) => r.n < this.capOf(r.class));
  }
}
