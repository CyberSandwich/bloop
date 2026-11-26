// The upload engine fetches the stored-name rule on first use (a lazy chunk). When that fetch fails the engine must
// neither lose a paused upload nor report a damaged file; this suite loads the engine with the chunk failing.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { makeWorld as MakeWorld, World } from "./client-upload-world.ts";

let makeWorld: typeof MakeWorld;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../public/js/shared/file-name.js", () => {
    throw new Error("offline");
  });
  ({ makeWorld } = await import("./client-upload-world.ts"));
});

afterAll(() => {
  vi.doUnmock("../../public/js/shared/file-name.js");
  vi.resetModules();
});

const row = { id: "up1", name: "Lecture 5.pptx", bytes: 50, done: 1, parts: 3, createdAt: 1 };
const listing = (world: World) =>
  world.intercept.push((c) =>
    c.method === "GET" && c.path === "/api/uploads" ? world.json(200, { uploads: [row] }) : undefined,
  );

describe("the name rule cannot be fetched", () => {
  it("choosing the file again keeps the paused upload: nothing is closed or started", async () => {
    const world = makeWorld({ done: [1] });
    listing(world);
    const up = world.start();
    await world.flush();
    await up.resume(world.last.files[0]?.id as number, world.file(50));
    await world.flush();
    expect(world.calledPaths("DELETE")).toEqual([]);
    expect(world.calledPaths("POST")).toEqual([]);
    expect(world.last.files).toMatchObject([{ state: "paused", uploadId: "up1" }]);
  });

  it("a new file is refused as service_busy, which the person can retry, not as a damaged file", async () => {
    const world = makeWorld();
    const up = world.start();
    up.add([world.file(50)]);
    await world.flush();
    expect(world.last.files[0]).toMatchObject({ state: "refused", error: "service_busy" });
    expect(world.calledPaths("POST")).toEqual([]);
  });
});
