import { describe, expect, it } from "vitest";
import { isoWeek, type MetricEvent, percentile, summarize } from "../../src/worker/metrics.ts";
import { D1Metrics } from "../../src/worker/metrics-d1.ts";
import { testDb } from "./d1-shim.ts";

const T0 = Date.parse("2026-03-01T10:00:00Z");
const DAY = 86_400_000;
const metric = (over: Partial<MetricEvent>): MetricEvent => ({
  at: T0,
  mode: "live",
  kind: "owner",
  roomId: null,
  name: "scan_to_open_ms",
  ...over,
});

describe("metric math", () => {
  it("takes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("groups by mode, name and cause, and keeps failures without a duration", () => {
    const out = summarize([
      { mode: "live", name: "scan_to_open_ms", cause: "", ms: 4000 },
      { mode: "live", name: "scan_to_open_ms", cause: "", ms: 8000 },
      { mode: "live", name: "failure", cause: "bad_structure", ms: null },
      { mode: "live", name: "failure", cause: "bad_structure", ms: null },
      { mode: "demo", name: "scan_to_open_ms", cause: "", ms: 1000 },
    ]);
    expect(out).toContainEqual({
      mode: "live",
      name: "scan_to_open_ms",
      cause: "",
      n: 2,
      p50Ms: 4000,
      p90Ms: 8000,
    });
    expect(out).toContainEqual({
      mode: "live",
      name: "failure",
      cause: "bad_structure",
      n: 2,
      p50Ms: null,
      p90Ms: null,
    });
    expect(out).toHaveLength(3);
  });

  it("names ISO weeks across a year boundary", () => {
    expect(isoWeek(Date.parse("2026-03-01T00:00:00Z"))).toBe("2026-W09");
    expect(isoWeek(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeek(Date.parse("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("metrics store", () => {
  it("records a duration and a failure cause, and summarizes a range", async () => {
    const db = testDb();
    const m = new D1Metrics(db, "pepper-pepper-pepper-pepper-pepper!");
    await m.record(metric({ ms: 3100.4 }));
    await m.record(metric({ ms: 5000, at: T0 + 1 }));
    await m.record(metric({ name: "failure", cause: "link_expired", at: T0 + 2 }));
    await m.record(metric({ ms: 9999, at: T0 + DAY }));
    const s = await m.summary(T0, T0 + 1000);
    expect(s).toContainEqual({ mode: "live", name: "scan_to_open_ms", cause: "", n: 2, p50Ms: 3100, p90Ms: 5000 });
    expect(s).toContainEqual({ mode: "live", name: "failure", cause: "link_expired", n: 1, p50Ms: null, p90Ms: null });
  });

  it("stores no user and no file name: the table has no such column", () => {
    const db = testDb();
    const cols = db.raw
      .prepare("PRAGMA table_info(metric_event)")
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(["id", "at", "mode", "kind", "room_id", "name", "ms", "cause"]);
  });

  it("keeps one pseudonym per user per week, and never the user id", async () => {
    const db = testDb();
    const m = new D1Metrics(db, "pepper-pepper-pepper-pepper-pepper!");
    await m.activeWeek("user-1", T0);
    await m.activeWeek("user-1", T0 + 1000);
    await m.activeWeek("user-2", T0);
    const rows = db.raw.prepare("SELECT pseudonym, iso_week FROM metric_user_week").all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("user-");
    expect(rows[0]?.iso_week).toBe("2026-W09");
  });

  it("writes no pseudonym when there is no pepper", async () => {
    const db = testDb();
    await new D1Metrics(db, null).activeWeek("user-1", T0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM metric_user_week").get()).toEqual({ n: 0 });
  });

  it("DATA-02 retention: rolls old days into metric_daily, deletes the events, and is idempotent", async () => {
    const db = testDb();
    const m = new D1Metrics(db, null);
    const old = T0 - 100 * DAY;
    await m.record(metric({ at: old, ms: 1000 }));
    await m.record(metric({ at: old + 5, ms: 3000 }));
    await m.record(metric({ at: old + 9, name: "failure", cause: "link_gone" as never }));
    await m.record(metric({ at: T0 - 10 * DAY, ms: 2000 }));
    expect(await m.purge(T0, 90)).toBe(3);
    expect(await m.purge(T0, 90)).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM metric_event").get()).toEqual({ n: 1 });
    const daily = db.raw.prepare("SELECT name, cause, n, p50_ms, p90_ms FROM metric_daily ORDER BY name").all();
    expect(daily).toEqual([
      { name: "failure", cause: "link_gone", n: 1, p50_ms: null, p90_ms: null },
      { name: "scan_to_open_ms", cause: "", n: 2, p50_ms: 1000, p90_ms: 3000 },
    ]);
  });

  it("DATA-02 retention: drops rollups after two years and pseudonym weeks after 120 days", async () => {
    const db = testDb();
    const m = new D1Metrics(db, "pepper-pepper-pepper-pepper-pepper!");
    db.raw
      .prepare(
        "INSERT INTO metric_daily (day, mode, name, cause, n) VALUES ('2024-01-01', 'live', 'x', '', 1), ('2026-02-01', 'live', 'x', '', 1)",
      )
      .run();
    await m.activeWeek("u", T0 - 130 * DAY);
    await m.activeWeek("u", T0 - 20 * DAY);
    await m.purge(T0, 90);
    expect(db.raw.prepare("SELECT day FROM metric_daily").all()).toEqual([{ day: "2026-02-01" }]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM metric_user_week").get()).toEqual({ n: 1 });
  });
});
