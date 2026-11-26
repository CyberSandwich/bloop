import { describe, expect, it } from "vitest";
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
