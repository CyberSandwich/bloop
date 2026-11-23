// Counts the R2 operations bloop performs so it never leaves R2's free tier (ADR 0005). Cloudflare has no
// spending cap on R2, so the cap is ours: each operation is counted in D1 before it runs, per UTC month.
// Class A (put, list) and class B (get, head) are the billed classes; delete is free and is never counted.
import type { Db } from "../../auth/db.ts";

export type OpClass = "A" | "B";
export interface OpCaps {
  classA: number;
  classB: number;
}

/** 80% of the free tier (1,000,000 class A and 10,000,000 class B a month). */
export const DEFAULT_OP_CAPS: OpCaps = { classA: 800_000, classB: 8_000_000 };

export class R2Meter {
  constructor(
    private readonly db: Db,
    private readonly caps: OpCaps,
    private readonly now: () => number,
  ) {}

  private month = () => new Date(this.now()).toISOString().slice(0, 7);
  private capOf = (cls: OpClass) => (cls === "A" ? this.caps.classA : this.caps.classB);

  /**
   * Counts one operation, atomically. False, with nothing counted, when the month's cap is reached. Throws when
   * the counter cannot be written: callers must treat that as a refusal too (fail closed).
   */
  async charge(cls: OpClass): Promise<boolean> {
    // The upsert's WHERE makes a refused charge return no row, so the counter stops at the cap.
    const row = await this.db
      .prepare(
        `INSERT INTO r2_ops (month, class, n) VALUES (?1, ?2, 1)
         ON CONFLICT (month, class) DO UPDATE SET n = n + 1 WHERE n < ?3
         RETURNING n`,
      )
      .bind(this.month(), cls, this.capOf(cls))
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
