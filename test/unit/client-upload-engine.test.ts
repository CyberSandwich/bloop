// The upload engine end to end over a fake world (client-upload-world.ts): the wire, the parts loop, retries, waiting,
// the fill, cancel, resume and the guest's send.
import { describe, expect, it } from "vitest";
import { makeWorld, NETWORK, type Put, type World } from "./client-upload-world.ts";

/** Starts one file of `size` bytes and lets the create and the first parts go out. */
async function begin(world: World, size: number, name?: string) {
  const up = world.start();
  const [id] = up.add([world.file(size, name)]);
  await world.flush();
  return { up, id: id as number };
}
const fileOf = (world: World) => world.last.files[0];
const states = (world: World) => world.snaps.map((b) => b.files[0]?.state);
const paths = (world: World, method?: string) => world.calledPaths(method);

describe("a library upload over a direct URL", () => {
  it("creates, sends each part, confirms all but the last, and completes with the last part riding on it", async () => {
    const world = makeWorld();
    await begin(world, 50);
    expect(world.puts.map((p) => p.url)).toEqual([
      "https://r2.test/up1/1?sig=1",
      "https://r2.test/up1/2?sig=2",
      "https://r2.test/up1/3?sig=3",
    ]);
    const create = world.calls.find((c) => c.method === "POST" && c.path === "/api/uploads");
    expect(create?.body).toMatchObject({ name: "Lecture 5.pptx", bytes: 50 });
    expect(create?.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Every part but the last is confirmed with its ETag and size; the last one's confirmation rides on complete.
    const done = world.calls.filter((c) => c.path.endsWith("/done"));
    expect(done.map((c) => c.body)).toEqual([
      { etag: '"e1"', bytes: 20 },
      { etag: '"e2"', bytes: 20 },
    ]);
    const complete = world.calls.find((c) => c.path.endsWith("/complete"));
    expect(complete?.body).toEqual({ n: 3, etag: '"e3"', bytes: 10 });
    expect(fileOf(world)).toMatchObject({ state: "saved", fileId: "f1", fraction: 1 });
    expect(states(world)).toEqual(
      expect.arrayContaining(["queued", "fingerprinting", "starting", "uploading", "checking", "saved"]),
    );
  });

  it("a 3 MB file is one part: create, one PUT, complete", async () => {
    const world = makeWorld({ partBytes: 16 * 1024 * 1024 });
    await begin(world, 3 * 1024 * 1024);
    expect(world.puts).toHaveLength(1);
    expect(paths(world)).toEqual(["GET /api/uploads", "POST /api/uploads", "POST /api/uploads/up1/complete"]);
    expect(world.calls[2]?.body).toMatchObject({ n: 1, bytes: 3 * 1024 * 1024 });
  });

  it("sends no credential to the storage host: the cookie is the library's, and a guest's pid stays with bloop", async () => {
    const world = makeWorld({ kind: "guest" });
    await begin(world, 50);
    expect(world.puts.every((p) => p.url.startsWith("https://"))).toBe(true);
    expect(world.puts.flatMap((p) => Object.keys(p.headers))).toEqual([]);
    expect(world.calls.every((c) => c.headers.Authorization === "Bearer ref.secret")).toBe(true);
  });

  it("the guest's complete resolves the view the phone page takes", async () => {
    const world = makeWorld({ kind: "guest" });
    await begin(world, 50);
    expect(fileOf(world)).toMatchObject({ state: "sent", view: { state: "offered" } });
    expect(world.calls[0]?.headers.Authorization).toBe("Bearer ref.secret");
  });

  it("a library request carries no Authorization header: the session cookie is its credential", async () => {
    const world = makeWorld();
    await begin(world, 50);
    expect(world.calls.some((c) => "Authorization" in c.headers)).toBe(false);
  });

  it("vibrates once on Saved", async () => {
    const world = makeWorld();
    await begin(world, 50);
    expect(world.vibrations).toEqual([12]);
  });
});

describe("one Idempotency-Key per intent", () => {
  it("is reused by every retry of the create, and a second file gets its own", async () => {
    const world = makeWorld();
    let failures = 2;
    world.intercept.push((c) => {
      if (c.method === "POST" && c.path === "/api/uploads" && failures-- > 0) return world.problem(503, "internal");
    });
    const up = world.start();
    up.add([world.file(30, "a.pptx")]);
    await world.flush();
    await world.advance(1000);
    await world.advance(3000);
    const creates = world.calls.filter((c) => c.method === "POST" && c.path === "/api/uploads");
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((c) => c.headers["Idempotency-Key"]))).toEqual(new Set(["key-1"]));
    up.add([world.file(30, "b.pptx")]);
    await world.flush();
    const all = world.calls.filter((c) => c.method === "POST" && c.path === "/api/uploads");
    expect(all[3]?.headers["Idempotency-Key"]).toBe("key-2");
  });

  it("is reused when the create's answer is lost on the network", async () => {
    const world = makeWorld();
    let dropped = 1;
    world.intercept.push((c) =>
      c.path === "/api/uploads" && c.method === "POST" && dropped-- > 0 ? NETWORK : undefined,
    );
    await begin(world, 30);
    await world.advance(1000);
    const keys = world.calls
      .filter((c) => c.method === "POST" && c.path === "/api/uploads")
      .map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toEqual(["key-1", "key-1"]);
    expect(fileOf(world).state).toBe("saved");
  });
});

describe("resume", () => {
  it("the same fingerprint resumes: the create answers 200 with the parts done, and only the gaps are sent", async () => {
    const world = makeWorld({ done: [1, 2] });
    await begin(world, 50);
    expect(world.puts.map((p) => p.n)).toEqual([3]);
    expect(fileOf(world).state).toBe("saved");
  });

  it("a part the server already holds counts in the fill from the start", async () => {
    const world = makeWorld({ done: [1, 2] });
    world.onPut = () => {};
    await begin(world, 50);
    expect(fileOf(world).loaded).toBe(40);
    expect(fileOf(world).fraction).toBeCloseTo(0.8, 5);
  });
});

describe("the parts loop", () => {
  it("starts with 2 parts at once, adds one after two fast parts, and goes one at a time with fewer than 2 left", async () => {
    const world = makeWorld({ partBytes: 10 });
    world.onPut = () => {};
    await begin(world, 100);
    expect(world.live().map((p) => p.n)).toEqual([1, 2]);
    world.live()[0]?.ok();
    await world.flush();
    // One fast part so far: the pool refills to 2.
    expect(world.live().map((p) => p.n)).toEqual([2, 3]);
    world.live()[0]?.ok();
    await world.flush();
    // Two fast parts: 3 at once.
    expect(world.live().map((p) => p.n)).toEqual([3, 4, 5]);
  });

  it("goes one part at a time when fewer than 2 are left", async () => {
    const world = makeWorld({ partBytes: 10 });
    world.onPut = () => {};
    await begin(world, 20);
    expect(world.live().map((p) => p.n)).toEqual([1, 2]);
    world.live()[0]?.ok();
    await world.flush();
    expect(world.live().map((p) => p.n)).toEqual([2]);
  });

  it("a failure drops it to one part at a time", async () => {
    const world = makeWorld({ partBytes: 10, mode: "proxy" });
    world.onPut = () => {};
    await begin(world, 100);
    expect(world.live().map((p) => p.n)).toEqual([1, 2]);
    world.live()[0]?.reply(500);
    world.live()[0]?.ok();
    await world.flush();
    // The failed part is waiting out its second: nothing else starts beside it.
    expect(world.live()).toEqual([]);
    expect(world.puts).toHaveLength(2);
    await world.advance(1000);
    expect(world.live().map((p) => p.n)).toEqual([1]);
    world.live()[0]?.ok();
    await world.flush();
    // Two fast parts in a row (part 2, then the retry) earn the second slot back.
    expect(world.live().map((p) => p.n)).toEqual([3, 4]);
  });

  it("re-mints a part's URL when it has under 60 s left, measured on the page's clock", async () => {
    const world = makeWorld({ partBytes: 10, firstUrls: 4 });
    world.onPut = () => {};
    await begin(world, 40);
    expect(world.live().map((p) => p.n)).toEqual([1, 2]);
    world.state.now += 245_000;
    world.live()[0]?.ok();
    await world.flush();
    const mint = world.calls.filter((c) => c.path.endsWith("/urls"));
    expect(mint).toHaveLength(1);
    expect(mint[0]?.body).toEqual({ parts: [3, 4] });
    expect(world.puts.at(-1)?.url).toMatch(/\/3\?sig=\d+$/);
    expect(world.puts.at(-1)?.url).not.toBe("https://r2.test/up1/3?sig=3");
  });

  it("mints more URLs ahead of need, up to 8 at a time, never for a part that is done", async () => {
    const world = makeWorld({ partBytes: 10, firstUrls: 2, done: [] });
    world.onPut = () => {};
    await begin(world, 120);
    world.live()[0]?.ok();
    world.live()[0]?.ok();
    await world.flush();
    const mint = world.calls.filter((c) => c.path.endsWith("/urls"));
    expect(mint[0]?.body.parts.length).toBeLessThanOrEqual(8);
    expect(mint[0]?.body.parts).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("failures", () => {
  it("retries a failed part after 1, 3 and 9 s, then waits for the connection", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = (p) => p.fail();
    await begin(world, 50);
    expect(world.puts).toHaveLength(1);
    await world.advance(999);
    expect(world.puts).toHaveLength(1);
    await world.advance(1);
    expect(world.puts).toHaveLength(2);
    await world.advance(3000);
    expect(world.puts).toHaveLength(3);
    await world.advance(9000);
    expect(world.puts).toHaveLength(4);
    expect(fileOf(world).state).toBe("waiting");
    expect(world.last.etaMs).toBeNull();
    await world.advance(5000);
    expect(world.puts).toHaveLength(4);
  });

  it("a 5xx is retried the same way", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    let n = 0;
    world.onPut = (p) => (n++ < 2 ? p.reply(503) : p.ok());
    await begin(world, 50);
    await world.advance(1000);
    await world.advance(3000);
    expect(world.puts).toHaveLength(3);
    expect(fileOf(world).state).toBe("saved");
  });

  it("waiting resumes on online, asks the server which parts it holds, and sends only the gaps", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 10 });
    let offline = true;
    world.onPut = (p) => (offline && p.n !== 1 ? p.fail() : p.ok());
    await begin(world, 30);
    await world.advance(13_000);
    expect(fileOf(world).state).toBe("waiting");
    world.state.done.add(2);
    const sent = world.puts.length;
    offline = false;
    world.win.fire("online");
    await world.flush();
    expect(paths(world, "GET")).toContain("GET /api/uploads/up1");
    expect(world.puts.slice(sent).map((p) => p.n)).toEqual([3]);
    expect(fileOf(world).state).toBe("saved");
  });

  it("waiting also resumes when the page is visible again, and on a 15 s probe", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    let offline = true;
    world.onPut = (p) => (offline ? p.fail() : p.ok());
    await begin(world, 50);
    await world.advance(13_000);
    expect(fileOf(world).state).toBe("waiting");
    offline = false;
    world.doc.visibilityState = "hidden";
    world.doc.fire("visibilitychange");
    await world.flush();
    expect(fileOf(world).state).toBe("waiting");
    world.doc.visibilityState = "visible";
    world.doc.fire("visibilitychange");
    await world.flush();
    expect(fileOf(world).state).toBe("saved");

    const probed = makeWorld({ mode: "proxy", partBytes: 100 });
    let down = true;
    probed.onPut = (p) => (down ? p.fail() : p.ok());
    await begin(probed, 50);
    await probed.advance(13_000);
    down = false;
    await probed.advance(15_000);
    expect(fileOf(probed).state).toBe("saved");
  });

  it("goes to waiting at once when the page goes offline, and cuts the part on the wire", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    await begin(world, 50);
    world.win.fire("offline");
    await world.flush();
    expect(world.puts[0]?.aborted).toBe(true);
    expect(fileOf(world).state).toBe("waiting");
    world.onPut = (p) => p.ok();
    world.win.fire("online");
    await world.flush();
    expect(fileOf(world).state).toBe("saved");
  });

  it("a 2xx answer without bloop's marker is a filter's page, so the network and not a refusal (REL-03)", async () => {
    const world = makeWorld();
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads"
        ? new Response("<html>sign in to the wifi</html>", { status: 200 })
        : undefined,
    );
    await begin(world, 50);
    await world.advance(13_000);
    expect(fileOf(world).state).toBe("waiting");
    expect(fileOf(world).error).toBeUndefined();
  });

  it("waits out a 429 by its Retry-After and counts it as no failure", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    let n = 0;
    world.onPut = (p) => (n++ === 0 ? p.reply(429, { retryAfter: "7" }) : p.ok());
    await begin(world, 50);
    await world.advance(6999);
    expect(world.puts).toHaveLength(1);
    await world.advance(1);
    expect(world.puts).toHaveLength(2);
    expect(fileOf(world).state).toBe("saved");
  });

  it("a Retry-After beyond two minutes is a refusal to report, not a wait", async () => {
    const world = makeWorld();
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads"
        ? world.problem(429, "rate_limited", { "Retry-After": "3600" })
        : undefined,
    );
    await begin(world, 50);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "rate_limited" });
  });

  it("a row that is gone (404) pauses a library file and refuses a guest's", async () => {
    const lib = makeWorld({ mode: "proxy", partBytes: 100 });
    lib.onPut = (p) => p.reply(404, { text: JSON.stringify({ code: "not_found" }) });
    await begin(lib, 50);
    expect(fileOf(lib)).toMatchObject({ state: "paused", name: "Lecture 5.pptx" });
    const guest = makeWorld({ kind: "guest", mode: "proxy", partBytes: 100 });
    guest.onPut = (p) => p.reply(410);
    await begin(guest, 50);
    expect(fileOf(guest)).toMatchObject({ state: "refused", error: "upload_aborted" });
  });

  it("a part the proxy refuses with a code is that code's refusal, and the rest is cut", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 10 });
    world.onPut = (p) => (p.n === 1 ? p.reply(400, { text: JSON.stringify({ code: "too_large" }) }) : undefined);
    await begin(world, 50);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "too_large" });
    expect(world.puts.filter((p) => !p.finished).every((p) => p.aborted)).toBe(true);
  });
});

describe("direct uploads that cannot reach the storage host", () => {
  it("switches to proxy URLs after two network errors on direct PUTs before any direct part succeeded", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.onPut = (p) => (p.url.startsWith("https://") ? p.fail() : p.ok());
    await begin(world, 50);
    // The first network error retries after 1 s; the second switches, with no wait.
    await world.advance(1000);
    const direct = world.puts.filter((p) => p.url.startsWith("https://"));
    expect(direct).toHaveLength(2);
    const mint = world.calls.find((c) => c.path.endsWith("/urls"));
    expect(mint?.body).toEqual({ parts: [1], mode: "proxy" });
    expect(world.puts.at(-1)?.url).toBe("/api/uploads/up1/parts/1");
    expect(fileOf(world).state).toBe("saved");
    // A proxied part is recorded by the server: no done call, and complete carries no part.
    expect(world.calls.some((c) => c.path.endsWith("/done"))).toBe(false);
    expect(world.calls.find((c) => c.path.endsWith("/complete"))?.body).toEqual({});
  });

  it("a part sent through bloop carries the guest's credential, as a raw octet stream", async () => {
    const world = makeWorld({ kind: "guest", mode: "proxy", partBytes: 100 });
    await begin(world, 50);
    expect(world.puts[0]?.headers).toEqual({
      Authorization: "Bearer ref.secret",
      "Content-Type": "application/octet-stream",
    });
  });

  it("does not switch once a direct part has succeeded: errors then retry as usual", async () => {
    const world = makeWorld({ partBytes: 10 });
    let direct = 0;
    world.onPut = (p) => {
      if (p.n === 1) return p.ok();
      return direct++ < 2 ? p.fail() : p.ok();
    };
    await begin(world, 30);
    await world.advance(1000);
    await world.advance(3000);
    expect(world.calls.some((c) => c.body?.mode === "proxy")).toBe(false);
    expect(fileOf(world).state).toBe("saved");
  });

  it("a 403 re-mints once and is not counted as a failure", async () => {
    const world = makeWorld({ partBytes: 100 });
    let n = 0;
    world.onPut = (p) => (n++ === 0 ? p.reply(403) : p.ok());
    await begin(world, 50);
    // No waiting: the new URL is used at once.
    expect(world.puts).toHaveLength(2);
    expect(world.puts[1]?.url).not.toBe(world.puts[0]?.url);
    expect(world.calls.filter((c) => c.path.endsWith("/urls"))).toHaveLength(1);
    expect(fileOf(world).state).toBe("saved");
  });

  it("a second 403 on the fresh URL is a failure and waits 1 s", async () => {
    const world = makeWorld({ partBytes: 100 });
    let n = 0;
    world.onPut = (p) => (n++ < 2 ? p.reply(403) : p.ok());
    await begin(world, 50);
    expect(world.puts).toHaveLength(2);
    await world.advance(1000);
    expect(world.puts).toHaveLength(3);
  });

  it("a network error past the URL's expiry re-mints and is not counted toward the proxy switch", async () => {
    const world = makeWorld({ partBytes: 100 });
    let n = 0;
    world.onPut = (p) => {
      if (n++ === 0) {
        world.state.now += 301_000;
        return p.fail();
      }
      p.ok();
    };
    await begin(world, 50);
    expect(world.calls.some((c) => c.body?.mode === "proxy")).toBe(false);
    expect(world.puts[1]?.url).not.toBe(world.puts[0]?.url);
    expect(fileOf(world).state).toBe("saved");
  });

  it("a direct answer with no readable ETag is the network: CORS is not exposing it", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.onPut = (p) => (p.url.startsWith("https://") ? p.reply(200) : p.ok());
    await begin(world, 50);
    await world.advance(1000);
    expect(world.calls.find((c) => c.path.endsWith("/urls"))?.body.mode).toBe("proxy");
    expect(fileOf(world).state).toBe("saved");
  });
});

describe("a stalled part", () => {
  it("a part with no progress for 30 s is aborted and counted as a failure", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    let n = 0;
    world.onPut = (p) => {
      if (n++ === 0) p.progress(5);
      else p.ok();
    };
    await begin(world, 50);
    await world.advance(29_999);
    expect(world.puts[0]?.aborted).toBe(false);
    await world.advance(1);
    expect(world.puts[0]?.aborted).toBe(true);
    // The failure waits 1 s, like any other.
    expect(world.puts).toHaveLength(1);
    await world.advance(1000);
    expect(world.puts).toHaveLength(2);
    expect(fileOf(world).state).toBe("saved");
  });

  it("every progress event restarts the 30 s", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    await begin(world, 50);
    await world.advance(20_000);
    world.puts[0]?.progress(10);
    await world.advance(20_000);
    expect(world.puts[0]?.aborted).toBe(false);
    await world.advance(10_000);
    expect(world.puts[0]?.aborted).toBe(true);
  });
});

describe("the fill and the time left", () => {
  it("UP-11 fill never moves back on a part retry", async () => {
    const world = makeWorld({ partBytes: 20 });
    // Part 1 sends 5, 10, 15 bytes, fails mid-part, and its retry starts again from 3; part 2 goes through.
    const plan: Record<number, ((p: Put) => void)[]> = {
      1: [
        (p) => {
          p.progress(5);
          p.progress(10);
          p.progress(15);
          p.fail();
        },
        (p) => {
          p.progress(3);
          p.progress(9);
          p.progress(20);
          p.ok();
        },
      ],
      2: [
        (p) => {
          p.progress(8);
          p.progress(20);
          p.ok();
        },
      ],
    };
    world.onPut = (p) => plan[p.n]?.shift()?.(p);
    await begin(world, 40);
    await world.advance(1000);
    expect(fileOf(world).state).toBe("saved");
    const fills = world.snaps.map((b) => ({
      fraction: b.files[0].fraction,
      loaded: b.files[0].loaded,
      state: b.files[0].state,
    }));
    const before = fills.slice(
      0,
      fills.findIndex((f) => f.state === "saved"),
    );
    expect(before.length).toBeGreaterThan(8);
    for (let i = 1; i < fills.length; i++) {
      expect(fills[i]?.fraction, `event ${i}`).toBeGreaterThanOrEqual(fills[i - 1]?.fraction as number);
      expect(fills[i]?.loaded, `event ${i}`).toBeGreaterThanOrEqual(fills[i - 1]?.loaded as number);
    }
    // At most 99 percent until complete answers, then 100.
    expect(Math.max(...before.map((f) => f.fraction))).toBeLessThanOrEqual(0.99);
    expect(fills.at(-1)?.fraction).toBe(1);
    // The fill held where the failed part had taken it (15 + 8 = 23 of 40 at the most), not at the retry's 3.
    const afterFailure = fills.find((f, i) => i > 0 && f.loaded === 23);
    expect(afterFailure).toBeDefined();
  });

  it("UP-11 batch fill never moves back either, across files and a canceled one", async () => {
    const world = makeWorld({ partBytes: 100, mode: "proxy" });
    world.onPut = (p) => {
      p.progress(p.size / 2);
      p.ok();
    };
    const up = world.start();
    const [a, b] = up.add([world.file(50, "a.pptx"), world.file(50, "b.pptx")]);
    await world.flush();
    expect(world.last.fraction).toBe(1);
    up.cancel(b as number);
    const fractions = world.snaps.map((s) => s.fraction);
    expect(fractions).toEqual([...fractions].sort((x, y) => x - y));
    expect(a).not.toBe(b);
  });

  it("shows the time left only after 5 s of samples, and none while waiting", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100_000 });
    world.onPut = () => {};
    await begin(world, 200_000);
    const put = world.puts[0] as Put;
    for (let s = 1; s <= 4; s++) {
      await world.advance(1000);
      put.progress(s * 10_000);
    }
    expect(world.last.etaMs).toBeNull();
    for (let s = 5; s <= 7; s++) {
      await world.advance(1000);
      put.progress(s * 10_000);
    }
    expect(world.last.etaMs).toBeGreaterThan(0);
    world.win.fire("offline");
    await world.flush();
    expect(fileOf(world).state).toBe("waiting");
    expect(world.last.etaMs).toBeNull();
  });
});

describe("complete", () => {
  it("a refusal after checking is that code, and a library refusal never becomes a file", async () => {
    const world = makeWorld();
    world.intercept.push((c) =>
      c.path.endsWith("/complete")
        ? world.json(200, { state: "refused", file: { id: "f1", status: "refused", refusal: "macro_content" } })
        : undefined,
    );
    await begin(world, 50);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "macro_content" });
    expect(world.vibrations).toEqual([]);
  });

  it("is retried on a network error and answers once", async () => {
    const world = makeWorld();
    let dropped = 1;
    world.intercept.push((c) => (c.path.endsWith("/complete") && dropped-- > 0 ? NETWORK : undefined));
    await begin(world, 50);
    expect(fileOf(world).state).toBe("checking");
    await world.advance(1000);
    expect(fileOf(world).state).toBe("saved");
    const completes = world.calls.filter((c) => c.path.endsWith("/complete"));
    expect(completes).toHaveLength(2);
    expect(completes[1]?.body).toEqual(completes[0]?.body);
  });

  it("when the server says parts are missing it forgets the rider and sends the gaps", async () => {
    const world = makeWorld({ partBytes: 25 });
    let first = true;
    world.intercept.push((c) => {
      if (c.path.endsWith("/complete") && first) {
        first = false;
        return world.problem(400, "bad_request");
      }
    });
    world.onPut = () => {};
    await begin(world, 50);
    world.puts[0]?.ok();
    await world.flush();
    // Part 2 rides on the first complete, which the server does not count: it is sent again.
    world.onPut = (p) => p.ok();
    world.puts[1]?.ok();
    await world.flush();
    expect(world.puts.filter((p) => p.n === 2)).toHaveLength(2);
    expect(fileOf(world).state).toBe("saved");
  });

  it("a 409 upload_busy waits and tries again", async () => {
    const world = makeWorld();
    let busy = 1;
    world.intercept.push((c) =>
      c.path.endsWith("/complete") && busy-- > 0 ? world.problem(409, "upload_busy") : undefined,
    );
    await begin(world, 50);
    await world.advance(3000);
    expect(fileOf(world).state).toBe("saved");
  });
});

describe("refusals at the create", () => {
  it.each(["quota_exceeded", "library_full", "bad_type", "too_large", "upload_busy"])(
    "%s ends the file as refused with that code",
    async (code) => {
      const world = makeWorld();
      world.intercept.push((c) =>
        c.method === "POST" && c.path === "/api/uploads" ? world.problem(400, code) : undefined,
      );
      await begin(world, 50);
      expect(fileOf(world)).toMatchObject({ state: "refused", error: code });
      expect(world.puts).toEqual([]);
    },
  );

  it("a guest's unknown code is a bad request, and an empty file is never sent", async () => {
    const world = makeWorld({ kind: "guest" });
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads" ? world.problem(400, "made_up") : undefined,
    );
    await begin(world, 50);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "bad_request" });
    const empty = makeWorld();
    await begin(empty, 0);
    expect(fileOf(empty)).toMatchObject({ state: "refused", error: "empty" });
    expect(empty.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a refusal in a batch keeps the batch going", async () => {
    const world = makeWorld();
    let n = 0;
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads" && n++ === 0 ? world.problem(415, "bad_type") : undefined,
    );
    const up = world.start();
    up.add([world.file(30, "a.exe"), world.file(30, "b.pptx")]);
    await world.flush();
    expect(world.last.files.map((f: { state: string }) => f.state)).toEqual(["refused", "saved"]);
    expect(world.last.active).toBe(false);
  });
});

describe("a create answer the engine does not trust", () => {
  it("refuses a part size that would make a huge plan, before planning it", async () => {
    const world = makeWorld();
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads"
        ? world.json(201, { uploadId: "up1", partBytes: 1, parts: 450_000_000, done: [], mode: "direct", urls: [] })
        : undefined,
    );
    await begin(world, 450_000_000);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "service_down" });
  });

  it("refuses an answer whose parts do not match the size", async () => {
    const world = makeWorld();
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads"
        ? world.json(201, { uploadId: "up1", partBytes: 20, parts: 7, done: [], mode: "direct", urls: [] })
        : undefined,
    );
    await begin(world, 50);
    expect(fileOf(world).state).toBe("refused");
    expect(world.puts).toEqual([]);
  });

  it("never sends a part to a URL that is not https, nor to a proxy path other than the part's own", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.intercept.push((c) =>
      c.path === "/api/uploads" && c.method === "POST"
        ? world.json(201, {
            uploadId: "up1",
            partBytes: 100,
            parts: 1,
            done: [],
            mode: "direct",
            urls: [{ n: 1, url: "http://r2.test/up1/1" }],
          })
        : undefined,
    );
    await begin(world, 50);
    // The create's URL is dropped, so the part mints its own, which is https.
    expect(world.puts.map((p) => p.url)).toEqual(["https://r2.test/up1/1?sig=1"]);
    const proxy = makeWorld({ kind: "guest", mode: "proxy", partBytes: 100 });
    proxy.intercept.push((c) =>
      c.path === "/api/uploads/up1/urls"
        ? proxy.json(200, { urls: [{ n: 1, url: "https://evil.test/steal" }] })
        : undefined,
    );
    proxy.intercept.push((c) =>
      c.path === "/api/uploads" && c.method === "POST"
        ? proxy.json(201, {
            uploadId: "up1",
            partBytes: 100,
            parts: 1,
            done: [],
            mode: "proxy",
            urls: [{ n: 1, url: "https://evil.test/steal" }],
          })
        : undefined,
    );
    await begin(proxy, 50);
    expect(proxy.puts.every((p) => !p.url.includes("evil"))).toBe(true);
    expect(fileOf(proxy).state).toBe("refused");
  });

  it("encodes the upload id into every path it builds", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.intercept.push((c) =>
      c.path === "/api/uploads" && c.method === "POST"
        ? world.json(201, { uploadId: "a/../b?x#", partBytes: 100, parts: 1, done: [], mode: "direct", urls: [] })
        : undefined,
    );
    world.intercept.push((c) => (c.path.startsWith("/api/uploads/a") ? world.problem(404, "not_found") : undefined));
    await begin(world, 50);
    const touched = world.calls.map((c) => c.path).filter((p) => p !== "/api/uploads");
    expect(touched.every((p) => p.startsWith("/api/uploads/a%2F..%2Fb%3Fx%23"))).toBe(true);
  });
});

describe("cancel", () => {
  it("cuts the part on the wire, closes the upload on the server and ends the file", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    const { up, id } = await begin(world, 50);
    up.cancel(id);
    await world.flush();
    expect(world.puts[0]?.aborted).toBe(true);
    expect(paths(world, "DELETE")).toEqual(["DELETE /api/uploads/up1"]);
    expect(fileOf(world).state).toBe("canceled");
  });

  it("closes an upload whose create was still on the wire when it was canceled", async () => {
    const world = makeWorld();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = world.deps.fetch;
    world.deps.fetch = async (path: string, init: RequestInit = {}) => {
      if (path === "/api/uploads" && init.method === "POST") await held;
      return real(path, init);
    };
    const up = world.start();
    const [id] = up.add([world.file(50)]);
    await world.flush();
    expect(fileOf(world).state).toBe("starting");
    up.cancel(id as number);
    release();
    await world.flush();
    expect(paths(world, "DELETE")).toEqual(["DELETE /api/uploads/up1"]);
    expect(world.puts).toEqual([]);
    expect(fileOf(world).state).toBe("canceled");
  });

  it("cancels a queued file without ever creating it, and the batch goes on", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    const up = world.start();
    const [, second, third] = up.add([world.file(50, "a.pptx"), world.file(50, "b.pptx"), world.file(50, "c.pptx")]);
    await world.flush();
    up.cancel(second as number);
    world.onPut = (p) => p.ok();
    world.puts[0]?.ok();
    await world.flush();
    expect(world.last.files.map((f: { state: string }) => f.state)).toEqual(["saved", "canceled", "saved"]);
    expect(third).toBeDefined();
    expect(world.calls.filter((c) => c.method === "POST" && c.path === "/api/uploads")).toHaveLength(2);
  });

  it("is too late once the file is checking", async () => {
    const world = makeWorld();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = world.deps.fetch;
    world.deps.fetch = async (path: string, init: RequestInit = {}) => {
      if (path.endsWith("/complete")) await held;
      return real(path, init);
    };
    const { up, id } = await begin(world, 50);
    expect(fileOf(world).state).toBe("checking");
    up.cancel(id);
    release();
    await world.flush();
    expect(fileOf(world).state).toBe("saved");
    expect(paths(world, "DELETE")).toEqual([]);
  });
});

describe("paused rows", () => {
  const listing = (world: World, uploads: unknown[]) =>
    world.intercept.push((c) =>
      c.method === "GET" && c.path === "/api/uploads" ? world.json(200, { uploads }) : undefined,
    );
  const row = { id: "up1", name: "Lecture 5.pptx", bytes: 50, done: 1, parts: 3, createdAt: 1 };

  it("lists the library's open uploads as paused on init, and a guest asks for none", async () => {
    const world = makeWorld();
    listing(world, [row]);
    world.start();
    await world.flush();
    expect(world.last.files).toMatchObject([{ state: "paused", name: "Lecture 5.pptx", size: 50, uploadId: "up1" }]);
    expect(world.last.active).toBe(false);
    const guest = makeWorld({ kind: "guest" });
    guest.start();
    await guest.flush();
    expect(guest.calls).toEqual([]);
  });

  it("choosing the same file again resumes the same upload", async () => {
    const world = makeWorld({ done: [1] });
    listing(world, [row]);
    const up = world.start();
    await world.flush();
    up.resume(world.last.files[0].id, world.file(50));
    await world.flush();
    expect(fileOf(world)).toMatchObject({ state: "saved", uploadId: "up1" });
    expect(world.puts.map((p) => p.n)).toEqual([2, 3]);
    expect(paths(world, "DELETE")).toEqual([]);
  });

  it("a different file closes the paused row and starts fresh", async () => {
    const world = makeWorld();
    listing(world, [{ ...row, id: "old", bytes: 999 }]);
    const up = world.start();
    await world.flush();
    up.resume(world.last.files[0].id, world.file(50, "Other.pptx"));
    await world.flush();
    expect(paths(world, "DELETE")).toEqual(["DELETE /api/uploads/old"]);
    expect(fileOf(world)).toMatchObject({ state: "saved", name: "Other.pptx" });
  });

  it("a same-sized file that turns out to be another closes the paused row once the create names another upload", async () => {
    const world = makeWorld();
    listing(world, [{ ...row, id: "old" }]);
    const up = world.start();
    await world.flush();
    up.resume(world.last.files[0].id, world.file(50));
    await world.flush();
    expect(paths(world, "DELETE")).toEqual(["DELETE /api/uploads/old"]);
  });

  it("dismissing a paused row closes its upload", async () => {
    const world = makeWorld();
    listing(world, [row]);
    const up = world.start();
    await world.flush();
    up.cancel(world.last.files[0].id);
    await world.flush();
    expect(paths(world, "DELETE")).toEqual(["DELETE /api/uploads/up1"]);
    expect(fileOf(world).state).toBe("canceled");
  });

  it("an upload this page is already sending is not listed as paused", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.intercept.push((c) =>
      c.method === "GET" && c.path === "/api/uploads" ? world.json(200, { uploads: [row] }) : undefined,
    );
    const real = world.deps.fetch;
    world.deps.fetch = async (path: string, init: RequestInit = {}) => {
      const res = real(path, init);
      if (path === "/api/uploads" && init.method === "GET") await held;
      return res;
    };
    const up = world.start();
    up.add([world.file(50)]);
    await world.flush();
    release();
    await world.flush();
    expect(world.last.files.map((f: { state: string }) => f.state)).toEqual(["uploading"]);
  });
});

describe("effects while bytes move", () => {
  it("holds the screen awake and prompts before the page goes, only while bytes move", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100, wakeLock: true });
    world.onPut = () => {};
    await begin(world, 50);
    expect(world.locks).toHaveLength(1);
    expect(world.locks[0]?.released).toBe(false);
    expect(world.win.count("beforeunload")).toBe(1);
    world.win.fire("offline");
    await world.flush();
    expect(fileOf(world).state).toBe("waiting");
    expect(world.win.count("beforeunload")).toBe(0);
    expect(world.locks[0]?.released).toBe(true);
    world.onPut = (p) => p.ok();
    world.win.fire("online");
    await world.flush();
    expect(fileOf(world).state).toBe("saved");
    expect(world.win.count("beforeunload")).toBe(0);
    expect(world.locks.every((l) => l.released)).toBe(true);
  });

  it("asks for the lock again when the page is visible again", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100, wakeLock: true });
    world.onPut = () => {};
    await begin(world, 50);
    const [lock] = world.locks;
    if (lock) lock.released = true;
    world.doc.visibilityState = "visible";
    world.doc.fire("visibilitychange");
    await world.flush();
    expect(world.locks.length).toBeGreaterThanOrEqual(1);
  });

  it("cancel releases the lock and the prompt", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100, wakeLock: true });
    world.onPut = () => {};
    const { up, id } = await begin(world, 50);
    up.cancel(id);
    await world.flush();
    expect(world.locks.every((l) => l.released)).toBe(true);
    expect(world.win.count("beforeunload")).toBe(0);
  });

  it("dispose cuts everything and removes the page's listeners", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100, wakeLock: true });
    world.onPut = () => {};
    const { up } = await begin(world, 50);
    up.dispose();
    await world.flush();
    expect(world.puts[0]?.aborted).toBe(true);
    for (const type of ["online", "offline"]) expect(world.win.count(type)).toBe(0);
    expect(world.doc.count("visibilitychange")).toBe(0);
    expect(world.win.count("beforeunload")).toBe(0);
  });
});

describe("a batch", () => {
  it("is a queue: one file at a time, in order, the batch's total over every file", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    const up = world.start();
    up.add([world.file(30, "a.pptx"), world.file(40, "b.pdf")]);
    await world.flush();
    expect(world.last.total).toBe(70);
    expect(world.last.files.map((f: { state: string }) => f.state)).toEqual(["uploading", "queued"]);
    expect(world.puts).toHaveLength(1);
    world.puts[0]?.ok();
    await world.flush();
    expect(world.last.files.map((f: { state: string }) => f.state)).toEqual(["saved", "uploading"]);
    expect(world.last.loaded).toBe(30);
    world.puts[1]?.progress(20);
    expect(world.last.loaded).toBe(50);
  });

  it("a new pick while a batch runs joins it", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    const up = world.start();
    up.add([world.file(30, "a.pptx")]);
    await world.flush();
    up.add([world.file(40, "b.pdf")]);
    await world.flush();
    expect(world.last.files.map((f: { name: string }) => f.name)).toEqual(["a.pptx", "b.pdf"]);
    expect(world.last.total).toBe(70);
  });

  it("a pick after the batch ended starts a new one", async () => {
    const world = makeWorld();
    const up = world.start();
    up.add([world.file(30, "a.pptx")]);
    await world.flush();
    world.state.done.clear();
    up.add([world.file(30, "b.pdf")]);
    await world.flush();
    expect(world.last.files.map((f: { name: string }) => f.name)).toEqual(["b.pdf"]);
    expect(world.last.total).toBe(30);
  });
});

describe("a part the storage host keeps refusing", () => {
  it("a direct 400 is retried a few times, then refused: it never loops through waiting forever", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.onPut = (p) => (p.url.startsWith("https://") ? p.reply(400) : p.ok());
    await begin(world, 50);
    await world.advance(13_000);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "bad_request" });
    expect(world.puts).toHaveLength(4);
  });

  it("a direct 403 on a fresh URL counts toward the proxy switch, so a proxy that refuses the host goes through bloop", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.onPut = (p) => (p.url.startsWith("https://") ? p.reply(403) : p.ok());
    await begin(world, 50);
    await world.advance(1000);
    expect(world.calls.find((c) => c.path.endsWith("/urls") && c.body.mode === "proxy")).toBeDefined();
    expect(fileOf(world).state).toBe("saved");
  });

  it("a part's 429 is bounded like any request's: too many, or too long, is the rate_limited refusal", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = (p) => p.reply(429, { retryAfter: "1" });
    await begin(world, 50);
    await world.advance(10_000);
    expect(fileOf(world)).toMatchObject({ state: "refused", error: "rate_limited" });
    const long = makeWorld({ mode: "proxy", partBytes: 100 });
    long.onPut = (p) => p.reply(429, { retryAfter: "3600" });
    await begin(long, 50);
    expect(fileOf(long)).toMatchObject({ state: "refused", error: "rate_limited" });
  });
});

describe("the proxy switch while a direct mint is on the wire", () => {
  it("does not refuse the file: the part mints again through bloop", async () => {
    const world = makeWorld({ partBytes: 20, firstUrls: 1 });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.intercept.push(async (c) => {
      if (c.path.endsWith("/urls") && c.body.mode === undefined) {
        await held;
        return world.json(200, { urls: [{ n: 2, url: "https://r2.test/up1/2?late" }], ttlMs: 300000 });
      }
    });
    world.onPut = (p) => (p.url.startsWith("https://") ? p.fail() : p.ok());
    await begin(world, 40);
    await world.advance(5000);
    release();
    await world.advance(1000);
    expect(world.calls.some((c) => c.body?.mode === "proxy")).toBe(true);
    expect(fileOf(world).state).toBe("saved");
    expect(world.puts.every((p) => !p.url.includes("late"))).toBe(true);
  });
});

describe("cancel and dispose stop what was waiting", () => {
  it("a request whose backoff ends after the cancel is never sent", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = (p) => p.fail();
    const { up, id } = await begin(world, 50);
    up.cancel(id);
    const sent = world.calls.length;
    await world.advance(30_000);
    expect(world.puts).toHaveLength(1);
    expect(world.calls.slice(sent).map((c) => c.method)).toEqual([]);
    expect(paths(world, "DELETE")).toEqual(["DELETE /api/uploads/up1"]);
  });

  it("a create retrying its backoff is not sent again after the cancel", async () => {
    const world = makeWorld();
    world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/uploads" ? world.problem(503, "internal") : undefined,
    );
    const up = world.start();
    const [id] = up.add([world.file(50)]);
    await world.flush();
    up.cancel(id as number);
    await world.advance(30_000);
    expect(world.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("dispose does not fingerprint the files still queued", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    world.onPut = () => {};
    const up = world.start();
    up.add([world.file(50, "a.pptx"), world.file(50, "b.pptx"), world.file(50, "c.pptx")]);
    await world.flush();
    up.dispose();
    world.puts[0]?.ok();
    await world.flush();
    expect(world.calls.filter((c) => c.method === "POST" && c.path === "/api/uploads")).toHaveLength(1);
  });

  it("dispose while the wake lock is being granted lets it go as soon as it arrives", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100, wakeLock: true });
    let grant: () => void = () => {};
    world.lockGate = new Promise<void>((resolve) => {
      grant = resolve;
    });
    world.onPut = () => {};
    const { up } = await begin(world, 50);
    up.dispose();
    grant();
    await world.flush();
    expect(world.locks).toHaveLength(1);
    expect(world.locks[0]?.released).toBe(true);
  });
});

describe("waiting before there is an upload", () => {
  it("a create that has to wait never reads as uploading, and the file returns to Starting", async () => {
    const world = makeWorld();
    let down = true;
    world.intercept.push((c) =>
      down && c.method === "POST" && c.path === "/api/uploads" ? world.problem(503, "internal") : undefined,
    );
    await begin(world, 50);
    await world.advance(13_000);
    expect(fileOf(world).state).toBe("waiting");
    down = false;
    world.win.fire("online");
    await world.flush();
    expect(fileOf(world).state).toBe("saved");
    const beforeCreate = world.snaps.filter((b) => b.files[0].uploadId === undefined).map((b) => b.files[0].state);
    expect(beforeCreate).not.toContain("uploading");
    expect(beforeCreate.at(-1)).toBe("starting");
  });
});

describe("a request that never answers", () => {
  it("is the network after 30 s: the probe is not stuck behind it", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 100 });
    let offline = true;
    let hang = false;
    world.onPut = (p) => (offline ? p.fail() : p.ok());
    const real = world.deps.fetch;
    world.deps.fetch = (path: string, init: RequestInit = {}) =>
      hang && path === "/api/uploads/up1" ? new Promise<Response>(() => {}) : real(path, init);
    await begin(world, 50);
    await world.advance(13_000);
    expect(fileOf(world).state).toBe("waiting");
    offline = false;
    hang = true;
    await world.advance(15_000 + 29_999);
    expect(fileOf(world).state).toBe("waiting");
    hang = false;
    await world.advance(1 + 15_000);
    expect(fileOf(world).state).toBe("saved");
  });
});

describe("a batch's count", () => {
  it("never exceeds its total when a file leaves it mid-upload", async () => {
    const world = makeWorld({ mode: "proxy", partBytes: 1000 });
    world.onPut = (p) => {
      if (p.size === 100) p.progress(80);
    };
    const up = world.start();
    const [first] = up.add([world.file(100, "a.pptx"), world.file(10, "b.pptx"), world.file(10, "c.pptx")]);
    await world.flush();
    expect(world.last).toMatchObject({ loaded: 80, total: 120 });
    up.cancel(first as number);
    await world.flush();
    expect(world.last.total).toBe(20);
    expect(world.snaps.every((b) => b.loaded <= b.total)).toBe(true);
    expect(world.snaps.every((b) => b.fraction <= 0.99 || !b.active)).toBe(true);
  });
});

describe("what the server lists and sends", () => {
  it("a paused row needs a whole number of bytes", async () => {
    const world = makeWorld();
    const row = { id: "up1", name: "a.pptx", done: 0, parts: 1, createdAt: 1 };
    world.intercept.push((c) =>
      c.method === "GET" && c.path === "/api/uploads"
        ? world.json(200, {
            uploads: [
              { ...row, bytes: "5" },
              { ...row, bytes: 2.5 },
              { ...row, bytes: 1e300 },
              { ...row, bytes: -4 },
            ],
          })
        : undefined,
    );
    world.start();
    await world.flush();
    expect(world.snaps.at(-1)?.files ?? []).toEqual([]);
  });

  it("never sends a part to bloop's own origin as if it were storage", async () => {
    const world = makeWorld({ partBytes: 100 });
    world.intercept.push((c) =>
      c.path === "/api/uploads" && c.method === "POST"
        ? world.json(201, {
            uploadId: "up1",
            partBytes: 100,
            parts: 1,
            done: [],
            mode: "direct",
            urls: [{ n: 1, url: "https://bloop.test/api/uploads/up1/complete" }],
          })
        : undefined,
    );
    await begin(world, 50);
    expect(world.puts.map((p) => p.url)).toEqual(["https://r2.test/up1/1?sig=1"]);
  });
});
