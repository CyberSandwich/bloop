// SpendGuard: the one global Durable Object that holds exact counters, pool leases and the breaker's latched state
// (ADR 0029). The rate-limit bindings are per location and approximate; this is the exact count. Every method is
// synchronous, so the runtime never interleaves two callers inside a check and its write. ledger logic: meters.ts.
import { DurableObject } from "cloudflare:workers";
import { dbOf } from "../auth/db.ts";
import { isLocalOrigin } from "../config.ts";
import { readAnalytics } from "./analytics.ts";
import { type BreakerReport, d1Settings, d1SwitchStore, logNotify, type Notify, runBreaker } from "./breaker.ts";
import { CAPS, type CapName, type Caps, type MeterName, type PoolName, resolveCaps } from "./caps.ts";
import { type Spend, SpendClient, type SpendOps, type SpendRpc } from "./client.ts";
import { type AcquireResult, type History, Ledger, type Snapshot, type TakeResult } from "./meters.ts";
import type { SpendReport } from "./report.ts";
import type { SwitchName } from "./switches.ts";

type Vars = Record<string, unknown>;

export class SpendGuard extends DurableObject<Vars> implements SpendOps {
  private readonly ledger: Ledger;
  private overrides: Record<string, number>;

  constructor(ctx: DurableObjectState, env: Vars) {
    super(ctx, env);
    this.ledger = new Ledger(ctx.storage.sql, Date.now, (fn) => ctx.storage.transactionSync(fn));
    this.overrides = this.ledger.overrides();
  }

  private caps(): Caps {
    return resolveCaps(this.env, this.overrides as Partial<Record<CapName, number>>);
  }

  take(meter: MeterName, n: number, scope?: string): TakeResult {
    return this.ledger.take(meter, n, scope, this.caps(), Date.now());
  }

  record(meter: MeterName, n: number, scope?: string): void {
    this.ledger.record(meter, n, scope, Date.now());
  }

  refund(id: string, n: number): void {
    this.ledger.refund(id, n, Date.now(), this.caps());
  }

  acquire(pool: PoolName, ttlSeconds: number, scope?: string): AcquireResult {
    return this.ledger.acquire(pool, scope, ttlSeconds, this.caps(), Date.now());
  }

  release(leaseId: string): boolean {
    return this.ledger.release(leaseId);
  }

  snapshot(): Snapshot {
    return this.ledger.snapshot(Date.now(), this.caps());
  }

  prune(): void {
    this.ledger.prune(Date.now(), this.caps());
  }

  latchTrip(
    name: SwitchName,
    value: string,
    reason: string,
    reading: string,
    prior?: string,
    evaluatedAt?: number,
  ): boolean {
    return this.ledger.latchTrip(name, value, reason, reading, Date.now(), prior, evaluatedAt);
  }

  markAlerted(name: SwitchName, value: string): void {
    this.ledger.markAlerted(name, value);
  }

  resetTrip(name: SwitchName): boolean {
    return this.ledger.resetTrip(name, Date.now(), this.caps());
  }

  alertOnce(key: string): boolean {
    return this.ledger.alertOnce(key, Date.now());
  }

  /** Only known cap names are kept; a row can lower a cap and never raise it (resolveCaps takes the minimum). */
  setOverrides(values: Record<string, number>): void {
    const known = Object.fromEntries(Object.entries(values).filter(([name]) => Object.hasOwn(CAPS, name)));
    this.ledger.setOverrides(known);
    this.overrides = known;
  }

  unalert(key: string): void {
    this.ledger.unalert(key);
  }

  history(days: number): History {
    return this.ledger.history(Date.now(), days);
  }

  setReport(json: string): void {
    this.ledger.setBlob("report", json);
  }

  report(): string | undefined {
    return this.ledger.blob("report");
  }

  setLastAnalytics(json: string): void {
    this.ledger.setBlob("analytics", json);
  }

  lastAnalytics(): string | undefined {
    return this.ledger.blob("analytics");
  }

  analyticsRun(failed: boolean): number {
    return this.ledger.analyticsRun(failed);
  }
}

interface SpendEnv {
  SPEND_GUARD: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
}

/**
 * The raw stub. Same jurisdiction rule as stubs.ts. `public` is a second instance of the same class that holds only
 * the fail-open meters, so a flood of public calls cannot overload the one that guards uploads, conversion and export.
 */
export function spendStub(env: SpendEnv, instance: "global" | "public" = "global"): SpendRpc {
  const ns = isLocalOrigin(env.PUBLIC_ORIGIN) ? env.SPEND_GUARD : env.SPEND_GUARD.jurisdiction("eu");
  return ns.get(ns.idFromName(instance)) as unknown as SpendRpc;
}

/**
 * The composition root's one call: it builds the `Spend` every route and Durable Object receives in its deps, so
 * nothing else reaches for the guard by itself. Fail modes per meter: client.ts. `overrides` returns the `cap.<name>`
 * rows of the settings snapshot (`capOverridesOf`), so the client's own caps (the R2 block, the isolate allowances)
 * honor a lowered row like the guard's do.
 */
export const spendFor = (env: SpendEnv, overrides: () => Partial<Record<CapName, number>>): Spend =>
  new SpendClient({ global: () => spendStub(env), public: () => spendStub(env, "public") }, () =>
    resolveCaps(env as unknown as Vars, overrides()),
  );

/**
 * The latest spend report the breaker stored (at most 5 minutes old), for the /admin panel and the admin-only JSON
 * route; null before the first run or when the guard cannot be reached. Checks no auth: the caller must verify an
 * admin session.
 */
export async function spendReportFor(env: SpendEnv): Promise<SpendReport | null> {
  try {
    const json = await spendStub(env).report();
    return json ? (JSON.parse(json) as SpendReport) : null;
  } catch {
    return null;
  }
}

type BreakerEnv = SpendEnv & { DB: unknown; CF_ANALYTICS_TOKEN?: string; CF_ACCOUNT_ID?: string };

/** The cron's one call. `notify` defaults to a log line until A wires email. */
export function runSpendBreaker(env: BreakerEnv, notify: Notify = logNotify): Promise<BreakerReport> {
  const token = env.CF_ANALYTICS_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  return runBreaker({
    guard: spendStub(env),
    publicGuard: spendStub(env, "public"),
    store: d1SwitchStore(dbOf(env.DB), Date.now),
    settings: d1Settings(dbOf(env.DB)),
    notify,
    // The switch and threshold vars are read by name; an Env interface has no index signature, hence the cast.
    vars: env as unknown as Vars,
    now: Date.now,
    adminUrl: `${env.PUBLIC_ORIGIN}/admin`,
    ...(token && accountId
      ? { analytics: () => readAnalytics({ token, accountId, now: Date.now(), fetch: (...a) => fetch(...a) }) }
      : {}),
  });
}
