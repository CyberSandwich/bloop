import { describe, expect, it, vi } from "vitest";

const started = vi.hoisted(() => ({ calls: [] as unknown[], release: null as null | (() => void) }));

vi.mock("../../src/worker/convert/deps.ts", () => ({ convertDepsFor: () => ({ deps: true }) }));
vi.mock("../../src/worker/convert/start.ts", () => ({
  startConversion: (deps: unknown, req: unknown) => {
    started.calls.push([deps, req]);
    return new Promise<{ state: string }>((resolve) => {
      started.release = () => resolve({ state: "queued" });
    });
  },
}));

// A specifier in a variable: the node tsconfig has no workers types, so it must not follow this import into the Worker.
const READY = "../../src/worker/uploads/convert-ready.ts";
const { convertWhenReady } = (await import(READY)) as {
  convertWhenReady: (
    env: unknown,
    ctx?: { waitUntil: (p: Promise<unknown>) => void },
  ) => (file: { id: string; userId: string; ext: string }) => Promise<void>;
};

const file = { id: "f1", userId: "u1", ext: "pptx" };
const REQUEST = [
  { deps: true },
  {
    ownerKind: "library",
    fileId: "f1",
    version: 1,
    profile: "full",
    scope: "u1",
    target: { kind: "library", userId: "u1" },
  },
];

describe("a library file that turns ready starts its conversion", () => {
  it("hands the new version to startConversion, after the response when there is a request", async () => {
    started.calls.length = 0;
    const waiting: Promise<unknown>[] = [];
    await convertWhenReady({}, { waitUntil: (p) => void waiting.push(p) })(file);
    expect(started.calls).toEqual([REQUEST]);
    expect(waiting).toHaveLength(1);
    started.release?.();
    await expect(waiting[0]).resolves.toEqual({ state: "queued" });
  });

  it("runs it inline where there is no request to outlive, as the sweep does", async () => {
    started.calls.length = 0;
    let finished = false;
    const run = convertWhenReady({})(file).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(started.calls).toEqual([REQUEST]);
    expect(finished).toBe(false);
    started.release?.();
    await run;
    expect(finished).toBe(true);
  });
});
