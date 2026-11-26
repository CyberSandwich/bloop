import { describe, expect, it } from "vitest";
import { isLocalRequest, testRelaxed } from "../../src/worker/auth/local.ts";
import { memberWorld } from "./member-fixture.ts";

const req = (url: string, ip?: string) => new Request(url, ip ? { headers: { "CF-Connecting-IP": ip } } : {});

describe("local requests: what every TEST_TIMING and DEV_MAILBOX relaxation also needs", () => {
  it("a local host with no client address or a loopback one is local; the edge's real address or a deployed host is not", () => {
    for (const r of [
      req("http://127.0.0.1:8787/x"),
      req("http://localhost:8787/x", "127.0.0.1"),
      req("http://[::1]:8787/x", "::1"),
    ]) {
      expect(isLocalRequest(r), r.url).toBe(true);
    }
    for (const r of [
      req("http://127.0.0.1:8787/x", "203.0.113.7"),
      req("https://bloop.here/x"),
      req("https://bloop.here/x", "127.0.0.1"),
      req("https://127.0.0.1.evil.example/x"),
    ]) {
      expect(isLocalRequest(r), `${r.url} ${r.headers.get("CF-Connecting-IP")}`).toBe(false);
    }
    expect(testRelaxed(req("http://127.0.0.1:8787/x"), { testTiming: false })).toBe(false);
    expect(testRelaxed(req("http://127.0.0.1:8787/x"), { testTiming: true })).toBe(true);
    expect(testRelaxed(req("http://127.0.0.1:8787/x", "198.51.100.1"), { testTiming: true })).toBe(false);
  });

  it("the dev mailbox answers a local request only, even with DEV_MAILBOX=1", async () => {
    const path = "../../src/worker/routes/dev-mail.ts";
    const { devMailRoutes } = (await import(path)) as {
      devMailRoutes: { methods: string[]; pattern: URLPattern; handler: (...a: unknown[]) => Promise<Response> }[];
    };
    const world = memberWorld({ DEV_MAILBOX: "1" });
    const read = devMailRoutes.find((r) => r.methods.includes("GET"));
    if (!read) throw new Error("no GET route");
    const call = (r: Request) => read.handler(r, world.env, read.pattern.exec(r.url), {});
    expect((await call(req("http://localhost:8787/api/dev/mailbox"))).status).toBe(200);
    expect((await call(req("http://localhost:8787/api/dev/mailbox", "203.0.113.7"))).status).toBe(404);
  });
});
