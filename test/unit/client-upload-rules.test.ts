// What the engine may send and trust, against the real routes' rules (see test/integration/upload-client.test.ts for
// the same engine against the real server): the one part that rides on complete, /urls' body, the direct hosts, how
// long a URL is kept, and a batch's fill.
import { describe, expect, it } from "vitest";
import { makeWorld, type World } from "./client-upload-world.ts";

async function begin(world: World, size: number) {
  const up = world.start();
  const [id] = up.add([world.file(size)]);
  await world.flush();
  return { up, id: id as number };
}
const urlCalls = (world: World) => world.calls.filter((c) => c.path.endsWith("/urls"));
const signed = Object.assign(new URL("https://acct.eu.r2.cloudflarestorage.com/up1/1"), { username: "u" }).href;

describe("the part that rides on complete", () => {
  it("is the last part only once every other is done: a last part that finishes early is confirmed like any other", async () => {
    const world = makeWorld({ partBytes: 20 });
    world.onPut = () => {};
    await begin(world, 60);
    world.puts[0]?.ok();
    await world.flush();
    world.puts.find((p) => p.n === 3)?.ok();
    await world.flush();
    world.puts.find((p) => p.n === 2)?.ok();
    await world.flush();
    expect(world.calls.filter((c) => c.path.endsWith("/done")).map((c) => c.path.match(/parts\/(\d)/)?.[1])).toEqual([
      "1",
      "3",
      "2",
    ]);
    expect(world.calls.find((c) => c.path.endsWith("/complete"))?.body).toEqual({});
    expect(world.last.files[0].state).toBe("saved");
  });

  it("a last part that finishes after every other rides, and nothing else does", async () => {
    const world = makeWorld({ partBytes: 20 });
    await begin(world, 60);
    const body = world.calls.find((c) => c.path.endsWith("/complete"))?.body;
    expect(body).toMatchObject({ n: 3 });
    expect(Object.keys(body).sort()).toEqual(["bytes", "etag", "n"]);
  });
});

describe("minting URLs", () => {
  it("sends {parts} and nothing else, whatever the mode", async () => {
    for (const mode of ["direct", "proxy"] as const) {
      const world = makeWorld({ partBytes: 20, mode, firstUrls: 1 });
      await begin(world, 100);
      const mints = urlCalls(world);
      expect(mints.length).toBeGreaterThan(0);
      for (const call of mints) expect(Object.keys(call.body)).toEqual(["parts"]);
    }
  });

  it("keeps a URL for half its life at least: a short-lived URL is not minted again at once", async () => {
    const early = makeWorld({ partBytes: 20, ttlMs: 90_000 });
    early.onPut = () => {};
    await begin(early, 60);
    early.state.now = 44_000;
    early.puts[0]?.ok();
    await early.flush();
    expect(urlCalls(early)).toEqual([]);
    expect(early.puts.find((p) => p.n === 3)?.url).toContain("/up1/3?sig=3");

    const late = makeWorld({ partBytes: 20, ttlMs: 90_000 });
    late.onPut = () => {};
    await begin(late, 60);
    late.state.now = 46_000;
    late.puts[0]?.ok();
    await late.flush();
    expect(urlCalls(late)).toHaveLength(1);
  });
});

describe("direct URLs", () => {
  const bad = [
    "https://evil.test/up1/1",
    "https://bloop.test/api/uploads/up1/complete",
    signed,
    "https://acct.eu.r2.cloudflarestorage.com.evil.test/up1/1",
    "https://acct.r2.cloudflarestorage.com/up1/1",
    "http://acct.eu.r2.cloudflarestorage.com/up1/1",
  ];

  it.each(bad)("never sends a part to %s: the part mints a URL of its own", async (url) => {
    const world = makeWorld({ partBytes: 100 });
    world.state.bytes = 50;
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads"
        ? world.json(201, {
            uploadId: "up1",
            partBytes: 100,
            parts: 1,
            done: [],
            mode: "direct",
            urls: [{ n: 1, url }],
          })
        : undefined,
    );
    await begin(world, 50);
    expect(world.puts.map((p) => p.url)).toEqual(["https://acct.eu.r2.cloudflarestorage.com/up1/1?sig=1"]);
  });
});

describe("a batch's fill", () => {
  const active = (world: World) => world.snaps.filter((b) => b.active).map((b) => b.fraction as number);

  it("UP-11 batch fill never goes back when a file leaves the batch mid-upload", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 1000 });
    world.onPut = (p) => {
      if (p.size === 100) p.progress(80);
    };
    const up = world.start();
    const [first] = up.add([world.file(100, "a.pptx"), world.file(10, "b.pptx"), world.file(10, "c.pptx")]);
    await world.flush();
    const held = world.last.fraction as number;
    expect(held).toBeGreaterThan(0.5);
    up.cancel(first as number);
    await world.flush();
    expect(world.last.total).toBe(20);
    expect(active(world)).toEqual([...active(world)].sort((a, b) => a - b));
    expect(world.last.fraction).toBeGreaterThanOrEqual(held);
    expect(world.last.fraction).toBeLessThanOrEqual(0.99);
  });

  it("UP-11 batch fill never goes back when a file is refused after it showed progress", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 1000 });
    world.onPut = (p) => {
      if (p.size === 100) {
        p.progress(90);
        p.reply(400, { text: JSON.stringify({ code: "too_large" }) });
      }
    };
    const up = world.start();
    up.add([world.file(100, "a.pptx"), world.file(10, "b.pptx")]);
    await world.flush();
    expect(active(world)).toEqual([...active(world)].sort((a, b) => a - b));
  });

  it("UP-11 batch fill starts from nothing again with a new batch", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 1000 });
    const up = world.start();
    up.add([world.file(30, "a.pptx")]);
    await world.flush();
    expect(world.last.fraction).toBe(1);
    world.state.done.clear();
    world.onPut = () => {};
    up.add([world.file(30, "b.pptx")]);
    await world.flush();
    expect(world.last.fraction).toBe(0);
    world.puts.at(-1)?.progress(15);
    expect(world.last.fraction).toBe(0.5);
  });
});
