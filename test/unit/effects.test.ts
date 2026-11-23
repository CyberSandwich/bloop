import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/worker/audit.ts";
import { type EffectDeps, runEffects } from "../../src/worker/do/effects.ts";
import type { Effect } from "../../src/worker/machine.ts";
import type { MetricEvent } from "../../src/worker/metrics.ts";
import type { Meta } from "../../src/worker/views.ts";
import { approved, CFG, claimedOwner, DECK, must, offered, sec, T0 } from "./machine-helpers.ts";

const META: Meta = {
  screenRef: "ref",
  mode: "live",
  roomId: "room-1",
  roomName: null,
  screenSecretHash: "x",
  createdAt: T0,
};

function fakes(over: Partial<EffectDeps> = {}) {
  const log: string[] = [];
  const audits: AuditEvent[] = [];
  const metrics: MetricEvent[] = [];
  const deps: EffectDeps = {
    directory: {
      put: async (code) => {
        log.push(`put ${code}`);
        return "ok";
      },
      remove: async (code) => {
        log.push(`remove ${code}`);
      },
    },
    audit: { record: async (e) => void audits.push(e) },
    metrics: {
      record: async (e) => void metrics.push(e),
      activeWeek: async (userId) => void log.push(`active ${userId}`),
    },
    seams: {
      mint: async (p) => void log.push(`mint ${p}`),
      revokeLinks: async () => void log.push("revoke"),
      purge: async (i) => void log.push(`purge ${i.file?.ref ?? "none"}`),
    },
    push: (to) => void log.push(`push ${to}`),
    deleteAll: async () => void log.push("deleteAll"),
    ...over,
  };
  return { deps, log, audits, metrics };
}

describe("effects: audit and metrics hooks at each transition", () => {
  it("records claimed with the session id, the actor and no file detail", async () => {
    const prev = claimedOwner();
    const f = fakes();
    await runEffects(
      [{ fx: "audit", type: "claimed", actor: "phone" }],
      { meta: META, prev, next: prev, now: T0 + 5 },
      f.deps,
    );
    expect(f.audits).toEqual([
      {
        sessionId: "s1",
        at: T0 + 5,
        actor: "phone",
        type: "claimed",
        detail: {},
        session: { screenRef: "ref", roomId: "room-1", mode: "live", kind: "owner", userId: null },
      },
    ]);
  });

  it("a live approval marks the account active, a demo one does not", async () => {
    const next = approved();
    const withUser = { ...next, pairing: next.pairing && { ...next.pairing, userId: "u1" } };
    const live = fakes();
    await runEffects(
      [{ fx: "audit", type: "approved", actor: "phone" }],
      { meta: META, prev: claimedOwner(), next: withUser, now: T0 },
      live.deps,
    );
    expect(live.log).toContain("active u1");
    const demo = fakes();
    await runEffects(
      [{ fx: "audit", type: "approved", actor: "phone" }],
      { meta: { ...META, mode: "demo" }, prev: claimedOwner(), next: withUser, now: T0 },
      demo.deps,
    );
    expect(demo.log).not.toContain("active u1");
  });

  it("records approved with the file name and source only", async () => {
    const next = approved();
    const f = fakes();
    await runEffects(
      [{ fx: "audit", type: "approved", actor: "phone" }],
      { meta: META, prev: claimedOwner(), next, now: T0 + sec(10) },
      f.deps,
    );
    expect(f.audits[0]?.detail).toEqual({ fileName: DECK.name, source: "mock" });
    expect(JSON.stringify(f.audits[0])).not.toContain(DECK.ref);
  });

  it("records ended from the previous session, with the reason", async () => {
    const prev = approved();
    const step = must(prev, { e: "end", now: T0 + sec(70), by: "screen" });
    const f = fakes();
    await runEffects(step.effects, { meta: META, prev, next: step.next, now: T0 + sec(70) }, f.deps);
    const ended = f.audits.find((a) => a.type === "ended");
    expect(ended).toMatchObject({ actor: "screen", detail: { fileName: DECK.name, source: "mock", reason: "screen" } });
    expect(f.metrics).toEqual([
      { at: T0 + sec(70), mode: "live", kind: "owner", roomId: "room-1", name: "session_minutes", ms: sec(60) },
    ]);
  });

  it("records a refused upload with its cause and a canceled claim with its reason", async () => {
    const f = fakes();
    const m = claimedOwner();
    await runEffects(
      [{ fx: "audit", type: "guest.refused", actor: "phone", cause: "bad_structure" }],
      { meta: META, prev: m, next: m, now: 1 },
      f.deps,
    );
    const timeout = must(offered(), { e: "timer", now: T0 + sec(400) });
    await runEffects(timeout.effects, { meta: META, prev: offered(), next: timeout.next, now: T0 + sec(400) }, f.deps);
    expect(f.audits[0]?.detail).toEqual({ cause: "bad_structure" });
    expect(f.audits[1]).toMatchObject({ type: "canceled", actor: "system", detail: { reason: "claim_timeout" } });
  });

  it("never puts a code, token, url or ip in a detail", async () => {
    const f = fakes();
    const prev = approved();
    const step = must(prev, { e: "end", now: T0 + sec(70), by: "phone" });
    await runEffects(step.effects, { meta: META, prev, next: step.next, now: T0 + sec(70) }, f.deps);
    const allowed = new Set(["fileName", "source", "purpose", "cause", "reason", "bytes", "ipMatch"]);
    for (const a of f.audits) for (const key of Object.keys(a.detail)) expect(allowed.has(key)).toBe(true);
  });

  it("keeps going when audit or metrics throw", async () => {
    const f = fakes({
      audit: { record: async () => Promise.reject(new Error("d1 down")) },
      metrics: {
        record: async () => Promise.reject(new Error("d1 down")),
        activeWeek: async () => Promise.reject(new Error("d1 down")),
      },
    });
    const prev = approved();
    const step = must(prev, { e: "end", now: T0 + sec(70), by: "phone" });
    await runEffects(step.effects, { meta: META, prev, next: step.next, now: T0 + sec(70) }, f.deps);
    expect(f.log.at(-1)).toBe("push both");
  });
});

describe("effects: order and the other seams", () => {
  it("runs effects in the order the machine lists them", async () => {
    const prev = approved();
    const step = must(prev, { e: "end", now: T0 + sec(70), by: "phone" });
    const f = fakes();
    await runEffects(step.effects, { meta: META, prev, next: step.next, now: T0 + sec(70) }, f.deps);
    expect(f.log).toEqual(["remove AAAAAA", "revoke", "purge deck-1", "push both"]);
  });

  it("calls the mint seam on approve and the purge seam with the session id", async () => {
    const prev = claimedOwner();
    const step = must(prev, { e: "restart", now: T0 + sec(5) });
    const f = fakes();
    const purges: unknown[] = [];
    f.deps.seams.purge = async (i) => void purges.push(i);
    await runEffects(
      [
        { fx: "mint", purpose: "protocol" },
        { fx: "purge", file: null },
      ],
      { meta: META, prev, next: step.next, now: 1 },
      f.deps,
    );
    expect(f.log).toContain("mint protocol");
    expect(purges).toEqual([{ sessionId: "s1", file: null }]);
  });

  it("stops at a Directory collision, before the push", async () => {
    const f = fakes();
    f.deps.directory.put = async () => "collision";
    const effects: Effect[] = [
      { fx: "directory.put", code: "AAAAAA", expiresAt: 1 },
      { fx: "push", to: "screen" },
    ];
    const m = claimedOwner();
    const result = await runEffects(effects, { meta: META, prev: m, next: m, now: 1 }, f.deps);
    expect(result).toEqual({ collided: true });
    expect(f.log).not.toContain("push screen");
  });

  it("runs deleteAll when the screen closes", async () => {
    const f = fakes();
    const m = claimedOwner();
    await runEffects([{ fx: "deleteAll" }], { meta: META, prev: m, next: m, now: CFG.closeAfterSeconds }, f.deps);
    expect(f.log).toEqual(["deleteAll"]);
  });
});
