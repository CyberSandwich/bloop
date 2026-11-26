import { describe, expect, it } from "vitest";
import { BODY_CAP, ContainerFault, Courier } from "../../src/worker/convert/courier.ts";
import type { ContainerPort } from "../../src/worker/convert/port.ts";
import { PROFILES } from "../../src/worker/convert/profile.ts";
import { buildStubOutputs } from "../../src/worker/convert/stub-outputs.ts";
import { begin, derived, drive, type Harness, harness, stepTo } from "./convert-harness.ts";

const prefix = "u/u1/f1/v1";
const bundleKeys = (h: Harness) => h.bucket.keys(prefix).filter((k) => k !== `${prefix}/orig`);

describe("CONV-04 the manifest is pinned", () => {
  it("a container that answers a different manifest after unit 0 fails the run and stores nothing more", async () => {
    const h = harness();
    const other = await buildStubOutputs("f1_v1_a1", "pptx", PROFILES.full, "a".repeat(64), { pages: 3, notes: [1] });
    let manifests = 0;
    h.respond = (path) =>
      path === "/out/manifest.json" && ++manifests >= 2 ? new Response(JSON.stringify(other.manifest)) : null;
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "output_invalid" });
    expect(bundleKeys(h)).toEqual([]);
  });
});

describe("CONV-12 a publish that already committed", () => {
  it("is done on the retry, and its outputs stay", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "publish");
    h.w.db.raw.prepare("UPDATE derived SET status = 'done', stage = NULL WHERE run_id = ?").run(h.runId);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "done" });
    expect(bundleKeys(h).length).toBeGreaterThan(0);
  });
});

describe("CONV-08 the two-start cap holds across runs", () => {
  it("a run whose version already used both starts ends failed without starting a container", async () => {
    const h = harness();
    await begin(h);
    await stepTo(h, "start");
    h.w.db.raw.prepare("UPDATE derived SET attempts = 2 WHERE run_id = ?").run(h.runId);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "start_failed", attempts: 2 });
    expect(h.starts).toEqual([]);
  });
});

describe("CONV-02 no container call outlives the run's deadline", () => {
  const portOf = (fetch: ContainerPort["fetch"]): ContainerPort => ({
    start: () => undefined,
    running: () => true,
    destroy: async () => undefined,
    setInactivity: async () => undefined,
    fetch,
  });

  it("a call is cut at the deadline even when its own timeout is longer", async () => {
    let waited = 0;
    const port = portOf(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          const start = Date.now();
          init.signal?.addEventListener("abort", () => {
            waited = Date.now() - start;
            reject(new Error("aborted"));
          });
        }),
    );
    const courier = new Courier(port);
    courier.limitAt = Date.now() + 40;
    await expect(courier.call("PUT", "/job/input/0", { timeoutMs: 60_000 })).rejects.toBeInstanceOf(ContainerFault);
    expect(waited).toBeLessThan(2000);
  });

  it("a call after the deadline is refused without reaching the container", async () => {
    let reached = 0;
    const courier = new Courier(
      portOf(async () => {
        reached++;
        return new Response("ok");
      }),
    );
    courier.limitAt = Date.now() - 1;
    await expect(courier.call("GET", "/healthz")).rejects.toBeInstanceOf(ContainerFault);
    expect(reached).toBe(0);
  });

  it("a status or error body over the cap reads as empty instead of filling memory", async () => {
    const courier = new Courier(portOf(async () => new Response("ok")));
    expect(await courier.drain(new Response("x".repeat(BODY_CAP + 1)))).toBe("");
    expect(await courier.drain(new Response("small"))).toBe("small");
  });
});

describe("CONV-12 a retry asks the switches again", () => {
  it("a breaker that trips between two attempts stops the second container", async () => {
    const h = harness();
    h.respond = (path) => {
      if (!path.startsWith("/job/input/")) return null;
      h.gates.convert = "off";
      return new Response('{"error":"already_started"}', { status: 409 });
    };
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "skipped", error: "off" });
    expect(h.starts).toHaveLength(1);
  });
});

describe("CONV-13 an end is counted once", () => {
  it("a finish that repeats after a fault does not record the run twice", async () => {
    const h = harness({ mode: "bomb" });
    let thrown = false;
    const terminal = h.notify.terminal.bind(h.notify);
    h.notify.terminal = async (...args: Parameters<typeof terminal>) => {
      if (!thrown) {
        thrown = true;
        throw new Error("notify down");
      }
      return terminal(...args);
    };
    await begin(h);
    await drive(h);
    expect(derived(h)).toMatchObject({ status: "failed", error: "bomb" });
    expect(h.spend.calls.filter((c) => c.startsWith("record:"))).toEqual(["record:conversion_failed"]);
  });
});
