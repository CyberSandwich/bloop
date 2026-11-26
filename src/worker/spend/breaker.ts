// The automatic breaker the */5 cron runs: reads the SpendGuard's exact counters and, when a token is set, the
// analytics API; builds the spend report; flips the matching switch row when a daily line or the month's budget is
// crossed; latches the flip until the owner resets it; sends one alert per trip and a digest on Mondays. Imports no
// Workers module, so the unit tests run it as is.
import type { Db } from "../auth/db.ts";
import { RESTRICTIVE, type Settings } from "../settings.ts";
import { type AnalyticsResult, type Readings, readingsOf } from "./analytics.ts";
import {
  COSTLY_FLIPS,
  capOverridesOf,
  guestDropLines,
  type MeterName,
  PRICED,
  resolveCaps,
  resolveTrips,
  type Trips,
} from "./caps.ts";
import { PUBLIC_METERS, type SpendRpc } from "./client.ts";
import type { History, Snapshot, TripRow } from "./meters.ts";
import { buildReport, digestText, isMonday, REPORT_DAYS, type SpendReport, weekKey } from "./report.ts";
import { effectiveSwitch, restrictiveness, type SettingsSnapshot, SWITCHES, type SwitchName } from "./switches.ts";

export const BREAKER_ACTOR = "breaker";
/** Stored as a trip's prior when the row could not be read at latch; no switch has this value. */
export const PRIOR_UNKNOWN = "?";

export interface Flip {
  switch: SwitchName;
  value: string;
}

export interface Alert {
  kind: "trip" | "warn" | "would_trip" | "analytics_down" | "public_unreadable" | "config_invalid" | "reset";
  /** The rule that fired; stable, so an alert rule can match it. */
  rule: string;
  switch?: SwitchName;
  value?: string;
  /** Every switch one trip flipped (the month's budget flips several): one alert, not one per switch. */
  flips?: Flip[];
  /** False on a trip whose switch row could not be written (D1 down): the latch holds, but nothing is flipped yet. */
  applied?: false;
  /** Plain numbers only: no file names, addresses or user data. */
  readings: Record<string, number>;
  /** Which sources fed this run, so an alert from counters alone says it saw only counters. */
  sources: string;
}

/** The Monday email: logged and mailed to ADMIN_EMAILS like every alert (ADR 0021). */
export interface DigestMessage {
  kind: "digest";
  subject: string;
  text: string;
  report: SpendReport;
}

export type Notify = (message: Alert | DigestMessage) => Promise<void>;

/** The structured log line every message also gets (an Observability alert matches `evt`); the cron adds mail. */
export const logNotify: Notify = async (message) => {
  console.log(JSON.stringify({ evt: "breaker", ...message }));
};

export interface SwitchStore {
  get(name: SwitchName): Promise<string | undefined>;
  /** The row with its writer, so a reset can tell a row the breaker wrote from one the owner set to the same value. */
  row(name: SwitchName): Promise<{ value: string; by: string | null } | undefined>;
  set(name: SwitchName, value: string, actor: string, reason: string): Promise<void>;
}

/** The D1 `setting` and `admin_action` tables (docs/spend.md has the DDL F adds). */
export function d1SwitchStore(db: Db, now: () => number): SwitchStore {
  const row: SwitchStore["row"] = async (name) => {
    const found = await db
      .prepare("SELECT value, updated_by FROM setting WHERE key = ?")
      .bind(name)
      .first<{ value: string; updated_by: string | null }>();
    return found ? { value: found.value, by: found.updated_by } : undefined;
  };
  return {
    row,
    get: async (name) => (await row(name))?.value,
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

/**
 * The settings reader as the breaker uses it. F's reader serves RESTRICTIVE, not an error, when D1 cannot be read; the
 * breaker must treat that as a failed read, or it would push empty cap rows and lift every lowered cap.
 */
export function settingsOf(read: () => Promise<Settings>): () => Promise<SettingsSnapshot> {
  return async () => {
    const settings = await read();
    if (settings === RESTRICTIVE) throw new Error("settings unreadable");
    return settings;
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

export interface EvalContext {
  vars: Readonly<Record<string, unknown>>;
  /** Meters whose counters could not be read this run: their rules are skipped, never evaluated as zero. */
  unread?: readonly MeterName[];
}

/** The pure decision: which warnings and trips this reading calls for. */
export function evaluate(
  snap: Snapshot,
  readings: Readings | undefined,
  t: Trips,
  report: SpendReport,
  ctx: EvalContext,
): Finding[] {
  const unread = ctx.unread ?? [];
  const out: Finding[] = [];
  const warn = (rule: string, reason: string, r: Record<string, number>) =>
    out.push({ rule, level: "warn", reason, readings: r });
  const trip = (rule: string, flips: Flip[], reason: string, r: Record<string, number>) =>
    out.push({ rule, level: "trip", flips, reason, readings: r });
  const day = (m: MeterName) => snap.counters[m].day;

  for (const row of report.meters) {
    if (unread.includes(row.meter as MeterName)) continue;
    const r = { today: Math.round(row.today), line: Number.isFinite(row.tripLine) ? Math.round(row.tripLine) : -1 };
    // A line that is zero or not a number is a broken configuration, not a free pass: it trips at once.
    const broken = !Number.isFinite(row.tripLine) || row.tripLine <= 0;
    if (broken || row.today >= row.tripLine)
      trip(`${row.meter}_day`, [PRICED[row.meter].flip], `${row.label} reached its daily trip line`, r);
    else if (row.today >= row.warnLine)
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
    if (unread.includes(c.meter)) continue;
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
  const dropLines = guestDropLines(t);
  if (drops >= dropLines.filesStopped)
    trip("guest_drops_files", [{ switch: "guest_files", value: "stopped" }], "guest drops in a day", {
      drops,
      line: dropLines.filesStopped,
    });
  if (drops >= dropLines.demoOff)
    trip("guest_drops_demo", [{ switch: "demo_drop", value: "off" }], "guest drops in a day", {
      drops,
      line: dropLines.demoOff,
    });

  const live = snap.pools.convert.live + snap.pools.convert_public.live;
  // The pools as the vars set them, not as a row lowered them: a lowered pool with leases still running is no leak.
  const poolCaps = resolveCaps(ctx.vars);
  const liveMax = poolCaps.pool_convert + poolCaps.pool_convert_public;
  if (live > liveMax)
    trip("leases_live", [{ switch: "convert", value: "off" }], "more live conversion leases than the pools allow", {
      live,
      line: liveMax,
    });
  // Only a lease dropped past deadline plus grace (one inside the grace is a release in flight), and only one
  // dropped since the owner's last reset, so a reset is not undone by the day's old count.
  const newDrops = snap.leasesDroppedToday - snap.leasesDroppedSeen;
  if (newDrops > 0)
    trip(
      "leases_overdue",
      [{ switch: "convert", value: "off" }],
      "a conversion lease outlived its deadline and grace: a container may be running",
      { overdue: newDrops },
    );

  const failed = day("conversion_failed");
  const total = failed + day("conversion_done");
  if (total >= t.convert_failed_min && pct(failed, total) > t.convert_failed_pct)
    trip("convert_failed", [{ switch: "convert", value: "off" }], "failed conversions in a day", {
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
  /** The second instance holding the public meters (`PUBLIC_METERS`); absent, `guard` holds them too. */
  publicGuard?: SpendRpc;
  store: SwitchStore;
  notify: Notify;
  /** The settings snapshot: its `cap.<name>` rows are pushed to the guard each run, where they can only lower a cap. */
  settings?: () => Promise<SettingsSnapshot>;
  vars: Readonly<Record<string, unknown>>;
  now: () => number;
  /** Where the digest and the report point: `<origin>/admin`. */
  adminUrl: string;
  /** Absent when `CF_ANALYTICS_TOKEN` or the account id is unset: the run uses counters only and says so. */
  analytics?: () => Promise<AnalyticsResult>;
  /** Names (never values) of the Worker vars that failed validation: the run still protects, and one alert a day says so. */
  configProblems?: readonly string[];
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
  /**
   * Claims `key` (once a UTC day, and across overlapping runs), sends, and releases the claim if the send fails so
   * the next run tries again. A failed send never stops the run: latched trips still apply.
   */
  const announce = async (key: string, message: Alert | DigestMessage): Promise<boolean> => {
    if (!(await d.guard.alertOnce(key))) return false;
    try {
      await d.notify(message);
      alerts++;
      return true;
    } catch (e) {
      await d.guard.unalert(key).catch(() => undefined);
      logError("notify", e, { key });
      return false;
    }
  };

  let sources = "counters only (no CF_ANALYTICS_TOKEN)";
  let analytics: AnalyticsResult | undefined;
  if (d.analytics) {
    const fresh = await d.analytics().catch(
      (e): AnalyticsResult => ({
        daily: {},
        failed: [{ dataset: "all", error: e instanceof Error ? e.message : "" }],
      }),
    );
    // A dataset that failed keeps its last good series and the last storage reading, and the report takes the larger
    // of that and the counters: a failed read never lowers the picture of spend.
    const last = await readLastAnalytics(d.guard);
    analytics = {
      daily: { ...last?.daily, ...fresh.daily },
      ...(fresh.r2StorageBytes !== undefined || last?.r2StorageBytes !== undefined
        ? { r2StorageBytes: (fresh.r2StorageBytes ?? last?.r2StorageBytes) as number }
        : {}),
      failed: fresh.failed,
    };
    await d.guard
      .setLastAnalytics(JSON.stringify({ daily: analytics.daily, r2StorageBytes: analytics.r2StorageBytes }))
      .catch((e) => logError("store analytics", e));
    const failedNames = analytics.failed.map((f) => f.dataset);
    sources = failedNames.length
      ? `counters plus analytics (failed: ${failedNames.join(", ")}; last good figures held)`
      : "counters plus analytics";
    const streak = await d.guard.analyticsRun(failedNames.length > 0);
    if (streak >= trips.analytics_fail_runs)
      await announce("analytics_down", {
        kind: "analytics_down",
        rule: "analytics_down",
        readings: { runs: streak },
        sources,
      });
  }
  const readings = analytics ? readingsOf(analytics, now) : undefined;
  const publicGuard = d.publicGuard ?? d.guard;
  // A failed read leaves the overrides the guards already hold: they only lower caps, so stale is safe.
  if (d.settings) {
    const rows = await d.settings().catch((e) => {
      logError("read settings", e);
      return undefined;
    });
    if (rows)
      for (const g of new Set([d.guard, publicGuard]))
        await g.setOverrides(capOverridesOf(rows) as Record<string, number>).catch((e) => logError("push caps", e));
  }

  const [global, open] = await Promise.all([
    readState(d.guard),
    d.publicGuard
      ? readState(d.publicGuard).catch((e) => {
          logError("read public guard", e);
          return undefined;
        })
      : undefined,
  ]);
  const { snap, history } = mergePublic(global, open);
  // An unreadable public instance leaves its meters unevaluated, and the report, the digest and one alert say so.
  const unread = d.publicGuard && !open ? PUBLIC_METERS : [];
  if (unread.length) {
    sources += `; public guard unreadable (${unread.join(", ")} not evaluated)`;
    await announce("public_guard_unreadable", {
      kind: "public_unreadable",
      rule: "public_guard_unreadable",
      readings: {},
      sources,
    });
  }
  if (d.configProblems) {
    const names = d.configProblems.join(",") || "unknown";
    sources += `; config invalid (${names})`;
    // Keyed by the names, so a second var broken later the same day still alerts.
    await announce(`config_invalid:${names}`, {
      kind: "config_invalid",
      rule: "config_invalid",
      readings: {},
      sources,
    });
  }
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
  const findings = evaluate(snap, readings, trips, report, { vars: d.vars, unread });

  for (const f of findings) {
    if (f.level === "trip" && f.flips && auto) {
      // The guard's latch is the source of truth; a trip already latched at this value or stricter is not new.
      for (const flip of f.flips) {
        const held = snap.trips.find((t) => t.switch === flip.switch);
        const latched = held && restrictiveness(flip.switch, held.value) >= restrictiveness(flip.switch, flip.value);
        // The row as it is before the breaker first tightens it, so a reset can put it back.
        const prior = latched
          ? ""
          : await d.store.get(flip.switch).then(
              (v) => v ?? "",
              () => PRIOR_UNKNOWN,
            );
        await d.guard.latchTrip(flip.switch, flip.value, f.rule, JSON.stringify(f.readings), prior, snap.at);
      }
    } else {
      const flip = f.flips?.[0];
      await announce(`${f.level}:${f.rule}`, {
        kind: f.level === "trip" ? "would_trip" : "warn",
        rule: f.rule,
        ...(flip ? { switch: flip.switch, value: flip.value } : {}),
        ...(f.flips && f.flips.length > 1 ? { flips: f.flips } : {}),
        readings: f.readings,
        sources,
      });
    }
  }

  // Apply every latched trip, then announce the new ones: all switches one rule flipped in one alert. A trip whose
  // row could not be written is still announced, marked not applied, since that is when the owner must act by
  // deploy; it is marked alerted, and so announced as applied, only once the row is written. The latch holds it.
  const latched = (await d.guard.snapshot()).trips;
  const fresh = new Map<string, typeof latched>();
  const unapplied = new Map<string, typeof latched>();
  for (const t of latched) {
    let applied = true;
    if (auto) {
      try {
        if (!(await applyTrip(d, t))) continue;
      } catch (e) {
        applied = false;
        logError("apply trip", e, { switch: t.switch });
      }
    }
    if (!t.alerted) {
      const into = applied ? fresh : unapplied;
      into.set(t.reason, [...(into.get(t.reason) ?? []), t]);
    }
  }
  for (const [groups, applied] of [
    [fresh, true],
    [unapplied, false],
  ] as const)
    for (const [rule, group] of groups) {
      const first = group[0];
      if (!first) continue;
      try {
        const sent = await announce(`${trippedKey(first.switch, first.value)}${applied ? "" : UNAPPLIED}`, {
          kind: "trip",
          rule,
          switch: first.switch,
          value: first.value,
          ...(group.length > 1 ? { flips: group.map((t) => ({ switch: t.switch, value: t.value })) } : {}),
          ...(applied ? {} : { applied: false as const }),
          readings: parseReading(first.reading),
          sources,
        });
        if (sent && applied) for (const t of group) await d.guard.markAlerted(t.switch, t.value);
      } catch (e) {
        logError("mark trip alerted", e, { rule });
      }
    }

  let digestSent = false;
  if (isMonday(now)) {
    const { subject, text } = digestText(report);
    digestSent = await announce(`digest:${weekKey(now)}`, { kind: "digest", subject, text, report });
  }
  return {
    findings: findings.length,
    tripped: (await d.guard.snapshot()).trips.map((t) => t.switch),
    alerts,
    digestSent,
    sources,
  };
}

const trippedKey = (name: SwitchName, value: string) => `trip:${name}:${value}`;
/** Appended to the claim of the alert sent while the row could not be written, so the applied one is still sent. */
const UNAPPLIED = ":unapplied";

/**
 * Writes the row when the value in force (the stricter of the var and the row; an unknown row value counts as the
 * strictest) is looser than the trip. False when a reset cleared the latch since this run read it: the write must
 * not undo the reset.
 */
async function applyTrip(d: BreakerDeps, t: TripRow): Promise<boolean> {
  const varValue = d.vars[SWITCHES[t.switch].var];
  const held = effectiveSwitch(
    t.switch,
    typeof varValue === "string" ? varValue : undefined,
    await d.store.get(t.switch),
  );
  if (restrictiveness(t.switch, held) >= restrictiveness(t.switch, t.value)) return true;
  const latched = (await d.guard.snapshot()).trips;
  if (!latched.some((x) => x.switch === t.switch && x.value === t.value)) return false;
  await d.store.set(t.switch, t.value, BREAKER_ACTOR, t.reason);
  return true;
}

interface State {
  snap: Snapshot;
  history: History;
}

async function readState(guard: SpendRpc): Promise<State> {
  const [snap, history] = await Promise.all([guard.snapshot(), guard.history(REPORT_DAYS), guard.prune()]);
  return { snap, history };
}

/**
 * The public meters' counters and history come from the public instance. If it cannot be read they stay as the
 * global instance holds them (zero), and the log line says so.
 */
function mergePublic(global: State, open: State | undefined): State {
  if (!open) return global;
  const counters = { ...global.snap.counters };
  for (const m of PUBLIC_METERS) counters[m] = open.snap.counters[m];
  return {
    snap: { ...global.snap, counters },
    history: { ...global.history, series: { ...global.history.series, email: open.history.series.email } },
  };
}

async function readLastAnalytics(
  guard: SpendRpc,
): Promise<Pick<AnalyticsResult, "daily" | "r2StorageBytes"> | undefined> {
  try {
    const json = await guard.lastAnalytics();
    return json ? (JSON.parse(json) as Pick<AnalyticsResult, "daily" | "r2StorageBytes">) : undefined;
  } catch {
    return undefined;
  }
}

function parseReading(text: string): Record<string, number> {
  try {
    return JSON.parse(text) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * The owner's reset: puts the row back to what it was before the trip, then clears the latch, as one logged action.
 * Only a row the breaker wrote (still holding the trip's value, with `updated_by` the breaker) is restored: a row
 * someone set since stands, even to the same value, so a reset never loosens past a decision the breaker did not
 * make. The row goes first, so a failure leaves the latch. Checks no auth: the caller must verify an admin session
 * (and CSRF for a POST).
 */
export async function resetBreaker(
  d: Pick<BreakerDeps, "guard" | "store" | "notify">,
  name: SwitchName,
  actor: string,
): Promise<boolean> {
  const trip = (await d.guard.snapshot()).trips.find((t) => t.switch === name);
  let restored: string | undefined;
  const row = trip ? await d.store.row(name) : undefined;
  if (trip && row?.value === trip.value && row.by === BREAKER_ACTOR) {
    // An unknown prior (the row could not be read at latch) restores nothing: the default could loosen the owner's row.
    if (trip.prior !== PRIOR_UNKNOWN) {
      restored = trip.prior || SWITCHES[name].default;
      await d.store.set(name, restored, actor, "breaker reset");
    }
  }
  const was = await d.guard.resetTrip(name);
  // The same trip later the same day is a new event and gets its own alert.
  if (trip)
    for (const key of [trippedKey(name, trip.value), trippedKey(name, trip.value) + UNAPPLIED])
      await d.guard.unalert(key);
  if (was)
    await d.notify({
      kind: "reset",
      rule: "reset",
      switch: name,
      value: restored ?? "unchanged",
      readings: {},
      sources: actor,
    });
  return was;
}

/** Resets every latched trip: what the owner does after raising the budget or a ceiling. Checks no auth: see `resetBreaker`. */
export async function resetAllBreakers(
  d: Pick<BreakerDeps, "guard" | "store" | "notify">,
  actor: string,
): Promise<SwitchName[]> {
  const names = (await d.guard.snapshot()).trips.map((t) => t.switch);
  for (const name of names) await resetBreaker(d, name, actor);
  return names;
}
