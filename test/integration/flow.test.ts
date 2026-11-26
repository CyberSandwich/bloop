import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RequestCounter } from "./flow.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startPairing();
});
afterAll(() => wrangler?.stop());

describe("FLOW-00 harness: the request counter", () => {
  it("FLOW-00 harness: counts what an Api sends, by method and path, and resets", async () => {
    const counter = new RequestCounter();
    const api = new Api(wrangler.url, counter.fetch);
    expect((await api.post("/api/screens", { mode: "demo" })).status).toBe(201);
    expect((await api.get("/api/health")).status).toBe(200);
    expect(counter.seen).toEqual([
      { method: "POST", path: "/api/screens" },
      { method: "GET", path: "/api/health" },
    ]);
    expect(counter.count({ prefix: "/api/" })).toBe(2);
    expect(counter.count({ method: "POST" })).toBe(1);
    expect(counter.count({ method: "GET", prefix: "/api/screens" })).toBe(0);
    counter.reset();
    expect(counter.count()).toBe(0);
  });
});
