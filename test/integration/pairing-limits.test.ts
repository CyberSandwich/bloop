// Rate limits with production timing: no TEST_TIMING, so the platform bindings are live.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, claim, PEPPER, untilRefused } from "./pairing-client.ts";
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

describe("PAIR-07 limits: the global miss alarm", () => {
  it("PAIR-07 limits: 1,000 misses across IP hashes in a window log one alarm line and block nobody else", async () => {
    const alarm = await startWrangler({ HASH_PEPPER: PEPPER });
    try {
      const alarmApi = new Api(alarm.url);
      const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
      // 100 IPs of 10 distinct misses each: every IP stays at its own limit, the sum reaches 1,000.
      const misses = Array.from({ length: 1000 }, (_, i) => ({
        ip: `198.51.100.${Math.floor(i / 10) + 1}`,
        code: `${alphabet[Math.floor(i / 900)]}${alphabet[Math.floor(i / 30) % 30]}${alphabet[i % 30]}AAA`,
      }));
      for (let i = 0; i < misses.length; i += 20) {
        const batch = misses.slice(i, i + 20);
        const answers = await Promise.all(
          batch.map(({ ip, code }) => alarmApi.post("/api/claim", { code }, { headers: { "CF-Connecting-IP": ip } })),
        );
        for (const a of answers) expect(a.status).toBe(404);
      }
      const lines = alarm
        .output()
        .split("\n")
        .filter((l) => l.includes("pair.miss_alarm"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"misses":1000');
      const fresh = await alarmApi.post(
        "/api/claim",
        { code: "ZZZZZZ" },
        { headers: { "CF-Connecting-IP": "203.0.113.200" } },
      );
      expect(fresh.status).toBe(404); // still an ordinary miss, not a block
    } finally {
      await alarm.stop();
    }
  }, 120_000);
});

describe("PAIR-09 flood: the platform rate limit binding", () => {
  it("PAIR-09 flood: screen creation is limited per IP and recovers for another address", async () => {
    const ip = { headers: { "CF-Connecting-IP": "203.0.113.50" } };
    // The demo binding (RL_DEMO_CREATE in wrangler.jsonc) allows 12 a minute.
    const statuses = await untilRefused(12, async () => (await api.post("/api/screens", { mode: "demo" }, ip)).status);
    expect(statuses.at(-1)).toBe(429);
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
    const statuses = await untilRefused(20, async () => (await api.post("/api/claim", { code: "!!" }, ip)).status);
    expect(statuses.at(-1)).toBe(429);
    expect((await api.post("/api/claim", { code }, { headers: { "CF-Connecting-IP": "203.0.113.62" } })).status).toBe(
      200,
    );
  });
});

describe("PAIR-09 flood: the file listing is limited per session", () => {
  /** A paired demo phone, built from its own IPs so the create and claim bindings are not shared. */
  async function phone(n: number): Promise<string> {
    const created = await api.post<{ sid: string }>(
      "/api/screens",
      { mode: "demo" },
      { headers: { "CF-Connecting-IP": `203.0.113.${n}` } },
    );
    const code = (await api.get<{ code: { code: string } }>("/api/screen/state", created.body.sid)).body.code.code;
    const claimed = await api.post<{ pid: string }>(
      "/api/claim",
      { code },
      { headers: { "CF-Connecting-IP": `203.0.113.${n + 1}` } },
    );
    return claimed.body.pid;
  }

  it("PAIR-09 flood: /api/files answers 429 past the per-session limit, and another session is unaffected", async () => {
    const pid = await phone(100);
    const statuses = await untilRefused(20, async () => (await api.get("/api/files", pid)).status);
    expect(statuses.at(-1)).toBe(429);
    expect((await api.get("/api/files", await phone(110))).status).toBe(200);
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
