// Rate limits with production timing: no TEST_TIMING, so the platform bindings are live.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, claim, PEPPER } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startWrangler({ HASH_PEPPER: PEPPER });
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const OTHER_IP = { headers: { "CF-Connecting-IP": "203.0.113.7" } };

describe("PAIR-07 limits: typed code guesses are counted exactly per IP hash", () => {
  it("PAIR-07 limits: the 11th miss gives 429, and a valid code is refused too until the window ends", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const code = (await api.get<{ code: { code: string } }>("/api/screen/state", created.body.sid)).body.code.code;
    const guesses = [
      "AAAAAA",
      "BBBBBB",
      "CCCCCC",
      "DDDDDD",
      "EEEEEE",
      "FFFFFF",
      "GGGGGG",
      "HHHHHH",
      "JJJJJJ",
      "KKKKKK",
    ];
    for (const guess of guesses) {
      const res = await claim(api, guess);
      expect(res.status, guess).toBe(404);
      expect(res.body).toEqual({ type: "about:blank", status: 404, code: "code_unknown" });
    }
    const eleventh = await claim(api, "MMMMMM");
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ type: "about:blank", status: 429, code: "rate_limited" });
    expect((await claim(api, code)).status).toBe(429);

    // Another address is counted on its own and still gets through.
    const other = await api.post("/api/claim", { code }, OTHER_IP);
    expect(other.status).toBe(200);
  });

  it("PAIR-07 limits: a malformed code is refused before the Directory and costs no guess", async () => {
    const before = await api.post("/api/claim", { code: "!!" }, { headers: { "CF-Connecting-IP": "203.0.113.8" } });
    expect(before.status).toBe(400);
    for (let i = 0; i < 12; i++) {
      await api.post("/api/claim", { code: "!!" }, { headers: { "CF-Connecting-IP": "203.0.113.8" } });
    }
    const created = await api.post<{ sid: string }>(
      "/api/screens",
      { mode: "demo" },
      { headers: { "CF-Connecting-IP": "203.0.113.9" } },
    );
    const code = (await api.get<{ code: { code: string } }>("/api/screen/state", created.body.sid)).body.code.code;
    const ok = await api.post("/api/claim", { code }, { headers: { "CF-Connecting-IP": "203.0.113.8" } });
    expect(ok.status).toBe(200);
  });
});

describe("PAIR-09 flood: the platform rate limit binding", () => {
  it("PAIR-09 flood: screen creation is limited per IP and recovers for another address", async () => {
    const ip = { headers: { "CF-Connecting-IP": "203.0.113.50" } };
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await api.post("/api/screens", { mode: "demo" }, ip)).status);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
    const other = await api.post("/api/screens", { mode: "demo" }, { headers: { "CF-Connecting-IP": "203.0.113.51" } });
    expect(other.status).toBe(201);
  });

  it("PAIR-09 flood: claims are limited per IP", async () => {
    const ip = { headers: { "CF-Connecting-IP": "203.0.113.60" } };
    const created = await api.post<{ sid: string }>(
      "/api/screens",
      { mode: "demo" },
      { headers: { "CF-Connecting-IP": "203.0.113.61" } },
    );
    const code = (await api.get<{ code: { code: string } }>("/api/screen/state", created.body.sid)).body.code.code;
    // Malformed codes pass the Zod check but not normalize(), so they reach the binding without a Directory miss.
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++) statuses.push((await api.post("/api/claim", { code: "!!" }, ip)).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(20);
    expect((await api.post("/api/claim", { code }, { headers: { "CF-Connecting-IP": "203.0.113.62" } })).status).toBe(
      200,
    );
  });
});

describe("config fails closed", () => {
  it("answers 500 internal on every pairing route when a timing is below the production floor", async () => {
    const bad = await startWrangler({ HASH_PEPPER: PEPPER, CODE_TTL_SECONDS: "2" });
    try {
      const res = await new Api(bad.url).post("/api/screens", { mode: "demo" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ type: "about:blank", status: 500, code: "internal" });
      expect(bad.output()).toContain("CODE_TTL_SECONDS");
      expect(bad.output()).not.toContain(PEPPER);
    } finally {
      await bad.stop();
    }
  });

  it("refuses TEST_TIMING on a non-local origin", async () => {
    const bad = await startWrangler({ HASH_PEPPER: PEPPER, TEST_TIMING: "1", PUBLIC_ORIGIN: "https://bloop.example" });
    try {
      const res = await new Api(bad.url).post("/api/screens", { mode: "demo" }, { origin: "https://bloop.example" });
      expect(res.status).toBe(500);
      expect(bad.output()).toContain("TEST_TIMING");
    } finally {
      await bad.stop();
    }
  });
});
