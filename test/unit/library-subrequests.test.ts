// A Worker invocation may make at most 1,000 subrequests (D1, R2 and Durable Object calls all count). The library's
// hourly and daily runs do their work in bounded allotments; this counts what the heaviest backlog actually costs.
import { describe, expect, it } from "vitest";
import type { Db, Statement } from "../../src/worker/auth/db.ts";
import { type RetentionDeps, runLibraryRetention } from "../../src/worker/library/retention.ts";
import type { LibDb } from "../../src/worker/library/store.ts";
import { addFile, type LibTestDb, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
/** Under the platform's 1,000, leaving room for the cron's own calls before and after the library's. */
const BUDGET = 800;

type Tick = (cost?: number) => void;

function counted(db: LibTestDb, tick: Tick): LibDb {
  const wrap = (s: Statement): Statement => {
    const bound: Statement = {
      bind: (...v) => {
        s.bind(...v);
        return bound;
      },
      first: (...a) => {
        tick();
        return s.first(...(a as []));
      },
      run: () => {
        tick();
        return s.run();
      },
      all: () => {
        tick();
        return s.all();
      },
    } as Statement;
    return bound;
  };
  const counting: Db = { prepare: (sql) => wrap(db.prepare(sql)) };
  return {
    ...counting,
    batch: (statements: Statement[]) => {
      tick();
      return db.batch(statements);
    },
  } as LibDb;
}

describe("a library run stays inside the platform's subrequest limit", () => {
  it("the heaviest daily backlog costs under the budget in D1, R2 and Durable Object calls", async () => {
    const db = libWith([
      "a",
      "b",
      ...Array.from({ length: 12 }, (_, i) => `d${i}`),
      ...Array.from({ length: 70 }, (_, i) => `w${i}`),
    ]);
    const objects: Record<string, string> = {};
    for (let i = 0; i < 120; i++) {
      const user = i % 2 === 0 ? "a" : "b";
      addFile(db, { id: `t${i}`, user, trashedAt: 1, purgeAfter: NOW - 1 });
      for (let k = 0; k < 3; k++) objects[`u/${user}/t${i}/v1/d/${k}`] = "x";
    }
    for (let u = 0; u < 12; u++) {
      db.raw
        .prepare("UPDATE app_user SET status = 'deleting', delete_after = ?, email_norm = ? WHERE id = ?")
        .run(NOW - 1, `d${u}@x.test`, `d${u}`);
      for (let f = 0; f < 4; f++) {
        addFile(db, { id: `x${u}-${f}`, user: `d${u}` });
        objects[`u/d${u}/x${u}-${f}/v1/orig`] = "x";
      }
    }
    for (let i = 0; i < 70; i++) {
      db.raw
        .prepare("UPDATE app_user SET tid = 'email', email_norm = ?, last_seen_at = 1 WHERE id = ?")
        .run(`w${i}@x.test`, `w${i}`);
    }
    for (let i = 0; i < 130; i++) {
      objects[`purged/old${i}`] = JSON.stringify({ purgedAt: 0, resweepAfter: NOW - 1 });
      objects[`u/old${i}/late/v1/orig`] = "late";
    }
    for (let i = 0; i < 60; i++) {
      objects[`h/hold${i}`] = "copy";
      db.raw
        .prepare(
          "INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, created_at, release_after, copied_at) VALUES (?, 'f', NULL, 'library', ?, 1, ?, 1)",
        )
        .run(`hold${i}`, `h/hold${i}`, NOW - 1);
    }
    for (let i = 0; i < 1_500; i++) objects[`u/orphan${i}/f/v1/orig`] = "x";

    const tally = { n: 0 };
    const tick: Tick = (cost = 1) => {
      tally.n += cost;
    };
    const metered = new Proxy(fakeBucket(objects).bucket, {
      get: (target, key) => {
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          tick();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const deps = (): RetentionDeps => ({
      cancelConversion: async () => tick(),
      exporting: async () => {
        tick();
        return false;
      },
      now: () => NOW,
      endScreens: async () => tick(),
      closeSessions: async () => tick(),
      abortUploads: async () => {
        tick();
        return false;
      },
      eraseObject: async () => tick(),
      warn: async () => {
        tick(2);
        return true;
      },
      lockoutMembers: null,
    });
    await runLibraryRetention(
      { DB: counted(db, tick), LIBRARY: metered, GUEST_FILES: metered },
      { inactiveDays: 730, inactiveGraceDays: 30 },
      deps(),
      { daily: true },
    );
    expect(tally.n).toBeGreaterThan(100);
    expect(tally.n).toBeLessThanOrEqual(BUDGET);
  });
});
