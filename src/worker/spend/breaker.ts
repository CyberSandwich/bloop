// The automatic breaker the */5 cron runs: reads the SpendGuard's exact counters and, when a token is set, the
// analytics API; builds the spend report; flips the matching switch row when a daily line or the month's budget is
// crossed; latches the flip until the owner resets it; sends one alert per trip and a digest on Mondays. Imports no
// Workers module, so the unit tests run it as is.
import type { Db } from "../auth/db.ts";
import { type AnalyticsResult, type Readings, readingsOf } from "./analytics.ts";
import { COSTLY_FLIPS, type MeterName, PRICED, resolveTrips, type Trips } from "./caps.ts";
import type { SpendRpc } from "./client.ts";
import type { Snapshot } from "./meters.ts";
import { buildReport, digestText, isMonday, REPORT_DAYS, type SpendReport, weekKey } from "./report.ts";
import { effectiveSwitch, restrictiveness, SWITCHES, type SwitchName } from "./switches.ts";

export const BREAKER_ACTOR = "breaker";

export interface Flip {
  switch: SwitchName;
  value: string;
}

export interface Alert {
  kind: "trip" | "warn" | "would_trip" | "analytics_down" | "reset";
  /** The rule that fired; stable, so an alert rule can match it. */
  rule: string;
  switch?: SwitchName;
  value?: string;
  /** Every switch one trip flipped (the month's budget flips several): one alert, not one per switch. */
  flips?: Flip[];
  /** Plain numbers only: no file names, addresses or user data. */
  readings: Record<string, number>;
  /** Which sources fed this run, so an alert from counters alone says it saw only counters. */
  sources: string;
}

/** The Monday email. A sends it; until then it is logged. */
export interface DigestMessage {
  kind: "digest";
  subject: string;
  text: string;
  report: SpendReport;
}

export type Notify = (message: Alert | DigestMessage) => Promise<void>;

/** Until email exists the message is a structured log line (an Observability alert matches `evt`). */
export const logNotify: Notify = async (message) => {
  console.log(JSON.stringify({ evt: "breaker", ...message }));
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
  flips?: Flip[];
  readings: Record<string, number>;
  reason: string;
}

interface Capped {
  meter: MeterName;
  cap: "convert_demo_day" | "demo_session_day";
  flip: Flip;
}
// A meter with no price whose daily cap is the line: reaching it latches the switch, so the feature does not
// simply reopen at 00:00 UTC. (Priced meters use the adaptive lines of the report.)
const CAPPED: Capped[] = [
  { meter: "convert_demo", cap: "convert_demo_day", flip: { switch: "demo_drop", value: "off" } },
  { meter: "demo_session", cap: "demo_session_day", flip: { switch: "demo", value: "off" } },
];

const pct = (used: number, of: number) => (of > 0 ? (used / of) * 100 : 0);

/** The pure decision: which warnings and trips this reading calls for. */
export function evaluate(snap: Snapshot, readings: Readings | undefined, t: Trips, report: SpendReport): Finding[] {
  const out: Finding[] = [];
  const warn = (rule: string, reason: string, r: Record<string, number>) =>
    out.push({ rule, level: "warn", reason, readings: r });
  const trip = (rule: string, flips: Flip[], reason: string, r: Record<string, number>) =>
    out.push({ rule, level: "trip", flips, reason, readings: r });
  const day = (m: MeterName) => snap.counters[m].day;

  for (const row of report.meters) {
    const r = { today: Math.round(row.today), line: Math.round(row.tripLine) };
    if (row.tripLine > 0 && row.today >= row.tripLine)
      trip(`${row.meter}_day`, [PRICED[row.meter].flip], `${row.label} reached its daily trip line`, r);
    else if (row.tripLine > 0 && row.today >= row.warnLine)
      warn(`${row.meter}_day_warn`, `${row.label} is past ${t.warn_pct} percent of its trip line`, r);
  }

  const month = { monthToDateUsd: report.monthToDateUsd, budgetUsd: report.budgetUsd };
  if (report.monthToDateUsd >= report.budgetUsd)
    trip("month_budget", [...COSTLY_FLIPS], "month-to-date cost reached the budget", month);
  else if (pct(report.monthToDateUsd, report.budgetUsd) >= t.month_warn_pct)
    warn("month_budget_warn", `month-to-date cost is past ${t.month_warn_pct} percent of the budget`, month);

  for (const g of report.gauges)
    if (g.value >= g.warnAt) warn(`${g.name}_warn`, "R2 bytes stored", { value: g.value, line: g.warnAt });

  for (const c of CAPPED) {
    const used = day(c.meter);
    const cap = snap.caps[c.cap];
    const p = pct(used, cap);
    if (cap > 0 && p >= t.trip_pct) trip(`${c.meter}_cap`, [c.flip], `${c.meter} reached its daily cap`, { used, cap });
    else if (p >= t.warn_pct)
      warn(`${c.meter}_warn`, `${c.meter} is past ${t.warn_pct} percent of its daily cap`, { used, cap });
  }

  for (const m of ["r2_class_a", "r2_class_b"] as const) {
    const used = snap.counters[m].month;
    const cap = snap.caps[m === "r2_class_a" ? "r2_class_a_month" : "r2_class_b_month"];
    if (pct(used, cap) >= t.month_warn_pct)
      warn(`${m}_month`, `${m} is past ${t.month_warn_pct} percent of its monthly cap`, { used, cap });
  }

  const drops = day("guest_drop");
  if (drops >= t.guest_drops_files_stopped_day)
    trip("guest_drops_files", [{ switch: "guest_files", value: "stopped" }], "guest drops in a day", {
      drops,
      line: t.guest_drops_files_stopped_day,
    });
  if (drops >= t.guest_drops_demo_off_day)
    trip("guest_drops_demo", [{ switch: "demo_drop", value: "off" }], "guest drops in a day", {
      drops,
      line: t.guest_drops_demo_off_day,
    });

  const live = snap.pools.convert.live + snap.pools.convert_public.live;
  const overdue = snap.pools.convert.overdue + snap.pools.convert_public.overdue + snap.leasesDroppedToday;
  if (live > t.leases_live_max)
    trip("leases_live", [{ switch: "convert", value: "off" }], "more live conversion leases than the pools allow", {
      live,
      line: t.leases_live_max,
    });
  if (overdue > 0)
    trip(
      "leases_overdue",
      [{ switch: "convert", value: "off" }],
      "a conversion lease outlived its deadline: a container may be running",
      { overdue },
    );

  const failed = day("conversion_failed");
  const total = failed + day("conversion_done");
  if (total >= t.convert_failed_min && pct(failed, total) > t.convert_failed_pct)
    trip("convert_failed", [{ switch: "convert", value: "account_only" }], "failed conversions in a day", {
      failed,
      total,
    });

  if (readings) {
    const { workersRequests: w, workersRequests7dMean: mean, doRequests, doGbSeconds } = readings;
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
  }
  return out;
}

export interface BreakerDeps {
  guard: SpendRpc;
  store: SwitchStore;
  notify: Notify;
  vars: Readonly<Record<string, unknown>>;
  now: () => number;
  /** Where the digest and the report point: `<origin>/admin`. */
  adminUrl: string;
  /** Absent when `CF_ANALYTICS_TOKEN` or the account id is unset: the run uses counters only and says so. */
  analytics?: () => Promise<AnalyticsResult>;
}

export interface BreakerReport {
  findings: number;
  tripped: SwitchName[];
  alerts: number;
  digestSent: boolean;
  sources: string;
}

/** True while the owner has not set the breaker to alert_only (switch `breaker`). */
async function automatic(d: BreakerDeps): Promise<boolean> {
  const v = d.vars[SWITCHES.breaker.var];
  // D1 down: the var alone decides, and the row writes below fail and retry; the latch and the alerts still work.
  const row = await d.store.get("breaker").catch(() => undefined);
  return effectiveSwitch("breaker", typeof v === "string" ? v : undefined, row) === "auto";
}

const logError = (what: string, e: unknown, extra: Record<string, unknown> = {}) =>
  console.error(
    JSON.stringify({ evt: "breaker_error", what, ...extra, error: e instanceof Error ? e.message : "unknown" }),
  );

export async function runBreaker(d: BreakerDeps): Promise<BreakerReport> {
  const trips = resolveTrips(d.vars);
  const now = d.now();
  let alerts = 0;
  const send = async (message: Alert | DigestMessage) => {
    await d.notify(message);
    alerts++;
  };

  let sources = "counters only (no CF_ANALYTICS_TOKEN)";
  let analytics: AnalyticsResult | undefined;
  if (d.analytics) {
    analytics = await d.analytics();
    const failedNames = analytics.failed.map((f) => f.dataset);
    sources = failedNames.length
      ? `counters plus analytics (failed: ${failedNames.join(", ")})`
      : "counters plus analytics";
    const streak = await d.guard.analyticsRun(failedNames.length > 0);
    if (streak === trips.analytics_fail_runs)
      await send({ kind: "analytics_down", rule: "analytics_down", readings: { runs: streak }, sources });
  }
  const readings = analytics ? readingsOf(analytics, now) : undefined;

  const [snap, history] = await Promise.all([d.guard.snapshot(), d.guard.history(REPORT_DAYS), d.guard.prune()]);
  const report = buildReport({
    now,
    vars: d.vars,
    history,
    snapshot: snap,
    ...(analytics ? { analytics } : {}),
    adminUrl: d.adminUrl,
    sources,
  });
  await d.guard.setReport(JSON.stringify(report)).catch((e) => logError("store report", e));

  const auto = await automatic(d);
  const findings = evaluate(snap, readings, trips, report);

  for (const f of findings) {
    if (f.level === "trip" && f.flips && auto) {
      // The guard's latch is the source of truth; a trip already latched at this value or stricter is not new.
      for (const flip of f.flips) await d.guard.latchTrip(flip.switch, flip.value, f.rule, JSON.stringify(f.readings));
    } else if (await d.guard.alertOnce(`${f.level}:${f.rule}`)) {
      const flip = f.flips?.[0];
      await send({
        kind: f.level === "trip" ? "would_trip" : "warn",
        rule: f.rule,
        ...(flip ? { switch: flip.switch, value: flip.value } : {}),
        ...(f.flips && f.flips.length > 1 ? { flips: f.flips } : {}),
        readings: f.readings,
        sources,
      });
    }
  }

  // Apply every latched trip, then announce the new ones: all switches one rule flipped in one alert. A failed row
  // write or alert is retried next run; the latch holds it.
  const latched = (await d.guard.snapshot()).trips;
  const fresh = new Map<string, typeof latched>();
  for (const t of latched) {
    try {
      if (auto) {
        const held = (await d.store.get(t.switch)) ?? SWITCHES[t.switch].default;
        if (restrictiveness(t.switch, held) < restrictiveness(t.switch, t.value))
          await d.store.set(t.switch, t.value, BREAKER_ACTOR, t.reason);
      }
      if (!t.alerted) fresh.set(t.reason, [...(fresh.get(t.reason) ?? []), t]);
    } catch (e) {
      logError("apply trip", e, { switch: t.switch });
    }
  }
  for (const [rule, group] of fresh) {
    const first = group[0];
    if (!first) continue;
    try {
      await send({
        kind: "trip",
        rule,
        switch: first.switch,
        value: first.value,
        ...(group.length > 1 ? { flips: group.map((t) => ({ switch: t.switch, value: t.value })) } : {}),
        readings: parseReading(first.reading),
        sources,
      });
      for (const t of group) await d.guard.markAlerted(t.switch, t.value);
    } catch (e) {
      logError("alert trip", e, { rule });
    }
  }

  let digestSent = false;
  if (isMonday(now)) {
    const key = `digest:${weekKey(now)}`;
    if (await d.guard.alertOnce(key)) {
      try {
        const { subject, text } = digestText(report);
        await send({ kind: "digest", subject, text, report });
        digestSent = true;
      } catch (e) {
        // Release the claim so the next run (5 minutes on) tries again.
        await d.guard.unalert(key);
        logError("digest", e);
      }
    }
  }
  return {
    findings: findings.length,
    tripped: (await d.guard.snapshot()).trips.map((t) => t.switch),
    alerts,
    digestSent,
    sources,
  };
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

/** Resets every latched trip: what the owner does after raising the budget or a ceiling. */
export async function resetAllBreakers(
  d: Pick<BreakerDeps, "guard" | "store" | "notify">,
  actor: string,
): Promise<SwitchName[]> {
  const names = (await d.guard.snapshot()).trips.map((t) => t.switch);
  for (const name of names) await resetBreaker(d, name, actor);
  return names;
}
