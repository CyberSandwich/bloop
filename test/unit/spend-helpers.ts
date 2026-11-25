// Shared by the spend unit tests: a SqlLike over node:sqlite, a ledger with an injected clock, and an in-memory
// SpendRpc and SwitchStore for the breaker.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlLike } from "../../src/worker/do/demo-slots.ts";
import type { SwitchStore } from "../../src/worker/spend/breaker.ts";
import { type Caps, resolveCaps } from "../../src/worker/spend/caps.ts";
import type { Spend, SpendRpc } from "../../src/worker/spend/client.ts";
import { Ledger } from "../../src/worker/spend/meters.ts";
import type { Transaction } from "../../src/worker/spend/schema.ts";
import type { SwitchName } from "../../src/worker/spend/switches.ts";

export function sqlOver(db: DatabaseSync): SqlLike {
  return {
    exec(query, ...bindings) {
      const values = bindings as SQLInputValue[];
      if (/^\s*select/i.test(query)) {
        const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      if (values.length === 0) db.exec(query);
      else db.prepare(query).run(...values);
      return { toArray: () => [] };
    },
  };
}

/** 2026-11-25 12:00 UTC. */
export const T0 = Date.UTC(2026, 10, 25, 12);
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface Rig {
  db: DatabaseSync;
  ledger: Ledger;
  caps: Caps;
  /** A new Ledger over the same storage: a Durable Object waking again. */
  wake(): Ledger;
}

/** `bornAt` is when the guard first woke; by default 20 days before T0, so history counts as established. */
export function rig(vars: Record<string, unknown> = {}, bornAt = T0 - 20 * DAY): Rig {
  const db = new DatabaseSync(":memory:");
  const clock = () => bornAt;
  return {
    db,
    ledger: new Ledger(sqlOver(db), clock, transactionOver(db)),
    caps: resolveCaps(vars),
    wake: () => new Ledger(sqlOver(db), clock, transactionOver(db)),
  };
}

/** What `ctx.storage.transactionSync` is in the Durable Object. */
export const transactionOver =
  (db: DatabaseSync): Transaction =>
  (fn) => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

/** A SpendRpc backed by one Ledger and a settable clock. */
export function fakeGuard(vars: Record<string, unknown> = {}, start = T0, bornAt = T0 - 20 * DAY) {
  const r = rig(vars, bornAt);
  const clock = { now: start };
  let overrides: Record<string, number> = {};
  const caps = () => resolveCaps(vars, overrides);
  const guard: SpendRpc = {
    take: async (m, n, s) => r.ledger.take(m, n, s, caps(), clock.now),
    record: async (m, n, s) => r.ledger.record(m, n, s, clock.now),
    refund: async (m, n, s, at) => void r.ledger.refund(m, n, s, at, clock.now, caps()),
    acquire: async (p, ttl, s) => r.ledger.acquire(p, s, ttl, caps(), clock.now),
    release: async (id) => r.ledger.release(id),
    snapshot: async () => r.ledger.snapshot(clock.now, caps()),
    prune: async () => r.ledger.prune(clock.now),
    latchTrip: async (n, v, reason, reading, prior) => r.ledger.latchTrip(n, v, reason, reading, clock.now, prior),
    markAlerted: async (n, v) => r.ledger.markAlerted(n, v),
    resetTrip: async (n) => r.ledger.resetTrip(n),
    alertOnce: async (k) => r.ledger.alertOnce(k, clock.now),
    setOverrides: async (v) => {
      overrides = v;
      r.ledger.setOverrides(v);
    },
    analyticsRun: async (failed) => r.ledger.analyticsRun(failed),
    unalert: async (k) => r.ledger.unalert(k),
    history: async (days) => r.ledger.history(clock.now, days),
    setReport: async (json) => r.ledger.setBlob("report", json),
    report: async () => r.ledger.blob("report"),
    setLastAnalytics: async (json) => r.ledger.setBlob("analytics", json),
    lastAnalytics: async () => r.ledger.blob("analytics"),
  };
  return { guard, clock, ledger: r.ledger, rig: r };
}

/**
 * A `Spend` for unit tests of routes and Durable Objects (U, V2, A): every call is admitted and recorded, and any
 * method can be replaced to script a refusal. No guard, no fixture Worker.
 */
export function fakeSpend(overrides: Partial<Spend> = {}): Spend & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const spy =
    <A extends unknown[], R>(method: string, result: R) =>
    async (...args: A): Promise<R> => {
      calls.push({ method, args });
      return result;
    };
  return {
    calls,
    take: spy("take", { ok: true } as const),
    charge: spy("charge", { ok: true } as const),
    acquire: spy("acquire", { ok: true, leaseId: "lease-1", deadline: 0 } as const),
    release: spy("release", undefined),
    record: spy("record", undefined),
    refund: spy("refund", undefined),
    snapshot: spy("snapshot", null),
    ...overrides,
  };
}

export interface MemoryStore extends SwitchStore {
  rows: Map<string, string>;
  writes: { name: string; value: string; actor: string; reason: string }[];
  failNextSet: boolean;
  /** Switches whose row cannot be read, as when D1 is down. */
  unreadable: Set<string>;
}

export function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    rows: new Map(),
    writes: [],
    failNextSet: false,
    unreadable: new Set(),
    async get(name: SwitchName) {
      if (store.unreadable.has(name)) throw new Error("d1 down");
      return store.rows.get(name);
    },
    async set(name, value, actor, reason) {
      if (store.failNextSet) {
        store.failNextSet = false;
        throw new Error("d1 down");
      }
      store.rows.set(name, value);
      store.writes.push({ name, value, actor, reason });
    },
  };
  return store;
}
