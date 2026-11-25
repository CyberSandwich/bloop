// The automatic breaker the */5 cron runs: reads the SpendGuard's exact counters and, when a token is set, the
// analytics API; flips the matching switch row when a daily figure crosses its line; latches the flip until the
// owner resets it; sends one alert per trip. Imports no Workers module, so the unit tests run it as is.
import type { Db } from "../auth/db.ts";
import type { AnalyticsResult, Readings } from "./analytics.ts";
import { type CapName, type MeterName, resolveTrips, type Trips } from "./caps.ts";
import type { SpendRpc } from "./client.ts";
import type { Snapshot } from "./meters.ts";
import { effectiveSwitch, restrictiveness, SWITCHES, type SwitchName } from "./switches.ts";

export const BREAKER_ACTOR = "breaker";

export interface Alert {
  kind: "trip" | "warn" | "would_trip" | "analytics_down" | "reset";
  /** The rule that fired; stable, so an alert rule can match it. */
  rule: string;
  switch?: SwitchName;
  value?: string;
  /** Plain numbers only: no file names, addresses or user data. */
  readings: Record<string, number>;
  /** Which sources fed this run, so an alert from counters alone says it saw only counters. */
  sources: string;
}
export type Notify = (alert: Alert) => Promise<void>;

/** Until email exists the alert is a structured log line (an Observability alert matches `evt`). */
export const logNotify: Notify = async (alert) => {
  console.log(JSON.stringify({ evt: "breaker", ...alert }));
};

export interface SwitchStore {
  get(name: SwitchName): Promise<string | undefined>;
  set(name: SwitchName, value: string, actor: string, reason: string): Promise<void>;
}

/** The D1 `setting` and `admin_action` tables (docs/spend.md has the DDL F adds). */
export function d1SwitchStore(db: Db, now: () => number): SwitchStore {
  return {
    async get(name) {
      const row = await db.prepare("SELECT value FROM setting WHERE key = ?").bind(name).first<{ value: string }>();
      return row?.value;
    },
    async set(name, value, actor, reason) {
      const at = now();
      await db
        .prepare(
          "INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4",
        )
        .bind(name, value, at, actor)
        .run();
      await db
        .prepare(
          "INSERT INTO admin_action (at, admin_user_id, action, target_kind, target_id, reason) VALUES (?, ?, 'switch_flip', 'setting', ?, ?)",
        )
        .bind(at, actor, name, `${name}=${value}: ${reason}`)
        .run();
    },
  };
}

export interface Finding {
  rule: string;
  level: "warn" | "trip";
  flip?: { switch: SwitchName; value: string };
  readings: Record<string, number>;
  reason: string;
}

interface Capped {
  meter: MeterName;
  cap: CapName;
  flip: { switch: SwitchName; value: string };
}
// A daily meter that reaches its cap latches its switch, so the feature does not simply reopen at 00:00 UTC.
const CAPPED: Capped[] = [
  { meter: "container_seconds", cap: "container_seconds_day", flip: { switch: "convert", value: "account_only" } },
  { meter: "convert_demo", cap: "convert_demo_day", flip: { switch: "demo_drop", value: "off" } },
  { meter: "demo_session", cap: "demo_session_day", flip: { switch: "demo", value: "off" } },
  { meter: "email", cap: "email_day", flip: { switch: "email", value: "admin_only" } },
];

const pct = (used: number, of: number) => (of > 0 ? (used / of) * 100 : 0);

/** The pure decision: which warnings and trips this reading calls for. */
export function evaluate(snap: Snapshot, readings: Readings | undefined, t: Trips): Finding[] {
  const out: Finding[] = [];
  const warn = (rule: string, reason: string, r: Record<string, number>) =>
    out.push({ rule, level: "warn", reason, readings: r });
  const trip = (rule: string, flip: NonNullable<Finding["flip"]>, reason: string, r: Record<string, number>) =>
    out.push({ rule, level: "trip", flip, reason, readings: r });
  const day = (m: MeterName) => snap.counters[m].day;

  for (const c of CAPPED) {
    const used = day(c.meter);
    const cap = snap.caps[c.cap];
    const p = pct(used, cap);
    const r = { used, cap };
    if (cap > 0 && p >= t.trip_pct) trip(`${c.meter}_cap`, c.flip, `${c.meter} reached its daily cap`, r);
    else if (p >= t.warn_pct) warn(`${c.meter}_warn`, `${c.meter} is past ${t.warn_pct} percent of its daily cap`, r);
  }

  for (const m of ["r2_class_a", "r2_class_b"] as const) {
    const used = snap.counters[m].month;
    const cap = snap.caps[m === "r2_class_a" ? "r2_class_a_month" : "r2_class_b_month"];
    if (pct(used, cap) >= t.month_warn_pct)
      warn(`${m}_month`, `${m} is past ${t.month_warn_pct} percent of its monthly cap`, { used, cap });
  }

  // Presigned PUTs never pass the Worker's meter, so analytics can see more than the counter does.
  const a = Math.max(day("r2_class_a"), readings?.r2ClassA ?? 0);
  if (a >= t.r2_class_a_day_trip)
    trip("r2_class_a_day", { switch: "uploads", value: "readonly" }, "R2 class A operations in a day", {
      a,
      line: t.r2_class_a_day_trip,
    });
  else if (a >= t.r2_class_a_day_warn)
    warn("r2_class_a_day_warn", "R2 class A operations in a day", { a, line: t.r2_class_a_day_warn });
  const b = Math.max(day("r2_class_b"), readings?.r2ClassB ?? 0);
  if (b >= t.r2_class_b_day_warn)
    warn("r2_class_b_day_warn", "R2 class B operations in a day", { b, line: t.r2_class_b_day_warn });

  const drops = day("guest_drop");
  if (drops >= t.guest_drops_files_stopped_day)
    trip("guest_drops_files", { switch: "guest_files", value: "stopped" }, "guest drops in a day", {
      drops,
      line: t.guest_drops_files_stopped_day,
    });
  if (drops >= t.guest_drops_demo_off_day)
    trip("guest_drops_demo", { switch: "demo_drop", value: "off" }, "guest drops in a day", {
      drops,
      line: t.guest_drops_demo_off_day,
    });

  const live = snap.pools.convert.live + snap.pools.convert_public.live;
  const overdue = snap.pools.convert.overdue + snap.pools.convert_public.overdue + snap.leasesDroppedToday;
  if (live > t.leases_live_max)
    trip("leases_live", { switch: "convert", value: "off" }, "more live conversion leases than the pools allow", {
      live,
      line: t.leases_live_max,
    });
  if (overdue > 0)
    trip(
      "leases_overdue",
      { switch: "convert", value: "off" },
      "a conversion lease outlived its deadline: a container may be running",
      { overdue },
    );

  const failed = day("conversion_failed");
  const total = failed + day("conversion_done");
  if (total >= t.convert_failed_min && pct(failed, total) > t.convert_failed_pct)
    trip("convert_failed", { switch: "convert", value: "account_only" }, "failed conversions in a day", {
      failed,
      total,
    });

  if (readings) {
    const {
      workersRequests: w,
      workersRequests7dMean: mean,
      doRequests,
      doGbSeconds,
      r2StorageBytes,
      d1RowsWritten,
    } = readings;
    if (w !== undefined && w >= t.workers_requests_day_warn)
      warn("workers_requests", "Worker requests in a day", { w, line: t.workers_requests_day_warn });
    if (w !== undefined && mean !== undefined && w >= Math.max(t.workers_spike_floor, t.workers_spike_multiple * mean))
      warn("workers_spike", "Worker requests far above the trailing 7-day mean", { w, mean: Math.round(mean) });
    if (doRequests !== undefined && doRequests >= t.do_requests_day_warn)
      warn("do_requests", "Durable Object requests in a day", { doRequests, line: t.do_requests_day_warn });
    if (doGbSeconds !== undefined && doGbSeconds >= t.do_gb_seconds_day_warn)
      warn("do_duration", "Durable Object duration in a day", {
        doGbSeconds: Math.round(doGbSeconds),
        line: t.do_gb_seconds_day_warn,
      });
    if (r2StorageBytes !== undefined && r2StorageBytes >= t.r2_storage_bytes_warn)
      warn("r2_storage", "R2 bytes stored", { r2StorageBytes, line: t.r2_storage_bytes_warn });
    if (d1RowsWritten !== undefined && d1RowsWritten >= t.d1_rows_day_warn)
      warn("d1_rows", "D1 rows written in a day", { d1RowsWritten, line: t.d1_rows_day_warn });
  }
  return out;
}

export interface BreakerDeps {
  guard: SpendRpc;
  store: SwitchStore;
  notify: Notify;
  vars: Readonly<Record<string, unknown>>;
  now: () => number;
  /** Absent when `CF_ANALYTICS_TOKEN` or the account id is unset: the run uses counters only and says so. */
  analytics?: () => Promise<AnalyticsResult>;
}

export interface BreakerReport {
  findings: number;
  tripped: SwitchName[];
  alerts: number;
  sources: string;
}

/** True while the owner has not set the breaker to alert_only (switch `breaker`). */
async function automatic(d: BreakerDeps): Promise<boolean> {
  const v = d.vars[SWITCHES.breaker.var];
  // D1 down: the var alone decides, and the row writes below fail and retry; the latch and the alerts still work.
  const row = await d.store.get("breaker").catch(() => undefined);
  return effectiveSwitch("breaker", typeof v === "string" ? v : undefined, row) === "auto";
}

export async function runBreaker(d: BreakerDeps): Promise<BreakerReport> {
  const trips = resolveTrips(d.vars);
  let alerts = 0;
  const send = async (alert: Alert) => {
    await d.notify(alert);
    alerts++;
  };

  let sources = "counters only (no CF_ANALYTICS_TOKEN)";
  let readings: Readings | undefined;
  if (d.analytics) {
    const result = await d.analytics();
    readings = result.readings;
    const failedNames = result.failed.map((f) => f.dataset);
    sources = failedNames.length
      ? `counters plus analytics (failed: ${failedNames.join(", ")})`
      : "counters plus analytics";
    const streak = await d.guard.analyticsRun(failedNames.length > 0);
    if (streak === trips.analytics_fail_runs)
      await send({ kind: "analytics_down", rule: "analytics_down", readings: { runs: streak }, sources });
  }

  const [snap] = await Promise.all([d.guard.snapshot(), d.guard.prune()]);
  const auto = await automatic(d);
  const findings = evaluate(snap, readings, trips);

  for (const f of findings) {
    const flip = f.flip;
    if (f.level === "trip" && flip && auto) {
      // The guard's latch is the source of truth; a trip already latched at this value or stricter is not new.
      await d.guard.latchTrip(flip.switch, flip.value, f.rule, JSON.stringify(f.readings));
    } else if (await d.guard.alertOnce(`${f.level}:${f.rule}`)) {
      const kind = f.level === "trip" ? "would_trip" : "warn";
      await send({
        kind,
        rule: f.rule,
        ...(flip ? { switch: flip.switch, value: flip.value } : {}),
        readings: f.readings,
        sources,
      });
    }
  }

  // Apply and announce every latched trip. A failed row write or alert is retried next run: the latch holds it.
  const tripped: SwitchName[] = [];
  const latched = (await d.guard.snapshot()).trips;
  for (const t of latched) {
    tripped.push(t.switch);
    try {
      if (auto) {
        const row = await d.store.get(t.switch);
        const held = row ?? SWITCHES[t.switch].default;
        if (restrictiveness(t.switch, held) < restrictiveness(t.switch, t.value))
          await d.store.set(t.switch, t.value, BREAKER_ACTOR, t.reason);
      }
      if (!t.alerted) {
        await send({
          kind: "trip",
          rule: t.reason,
          switch: t.switch,
          value: t.value,
          readings: parseReading(t.reading),
          sources,
        });
        await d.guard.markAlerted(t.switch, t.value);
      }
    } catch (e) {
      console.error(
        JSON.stringify({ evt: "breaker_error", switch: t.switch, error: e instanceof Error ? e.message : "unknown" }),
      );
    }
  }
  return { findings: findings.length, tripped, alerts, sources };
}

function parseReading(text: string): Record<string, number> {
  try {
    return JSON.parse(text) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The owner's reset: clears the latch and returns the switch to its default, as one logged action. */
export async function resetBreaker(
  d: Pick<BreakerDeps, "guard" | "store" | "notify">,
  name: SwitchName,
  actor: string,
): Promise<boolean> {
  const was = await d.guard.resetTrip(name);
  await d.store.set(name, SWITCHES[name].default, actor, "breaker reset");
  if (was)
    await d.notify({
      kind: "reset",
      rule: "reset",
      switch: name,
      value: SWITCHES[name].default,
      readings: {},
      sources: actor,
    });
  return was;
}
