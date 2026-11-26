// The audit trail and the IT export against `wrangler dev` with a migrated local D1: the real Screen object
// writes the rows, the export reads them back. Rate limits run on a second instance with production timing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validDeck } from "../zip-builder.ts";
import { pairPhone, sendDrop } from "./drop-client.ts";
import { approveDemo, fetchLink, inOneWindow, sleep } from "./open-client.ts";
import { Api, PEPPER, startPairing } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

const TOKEN = "export-token-export-token-export-token-0000";
let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing({ IT_EXPORT_TOKEN: TOKEN }, { migrate: true });
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const exportUrl = (query = "") => `${wrangler.url}/api/it/export${query}`;
const get = (query = "", token: string | null = TOKEN) =>
  fetch(exportUrl(query), { headers: token ? { Authorization: `Bearer ${token}` } : {} });

type Row = Record<string, string | number | boolean | null>;
const rows = async (query = ""): Promise<Row[]> => (await get(`?format=json${query}`)).json() as Promise<Row[]>;

/** Waits for the Screen object's audit writes: they happen after the response that caused them. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const v = await read();
    if (ok(v)) return v;
    await sleep(100);
  }
  return read();
}

describe("audit rows: one per session event, in D1", () => {
  it("records a demo session from claim to end with the cause, and no file contents, token or URL", async () => {
    const { socket, pid, url } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    expect((await fetchLink(url)).status).toBe(200);
    await api.post("/api/end", {}, { auth: pid });

    const all = await until(rows, (r) => r.some((e) => e.type === "ended"));
    const session = all.find((e) => e.type === "claimed")?.session;
    const mine = all.filter((e) => e.session === session);
    expect(mine.map((e) => e.type)).toEqual(
      expect.arrayContaining(["claimed", "approved", "link.minted", "link.fetched", "ended"]),
    );
    expect(mine.find((e) => e.type === "approved")).toMatchObject({ mode: "demo", kind: "owner", user: null });
    expect(mine.find((e) => e.type === "ended")).toMatchObject({ actor: "phone", reason: "phone" });
    expect(mine.find((e) => e.type === "link.fetched")).toMatchObject({ purpose: "protocol", count: 1 });

    const text = JSON.stringify(all);
    expect(text).not.toContain("/f/");
    expect(text).not.toContain(pid);
    expect(text).not.toContain(url.split("/")[4] ?? "no-token");
    expect(text).not.toContain("PK\u0003\u0004"); // no file bytes

    const row = wrangler.d1(
      `SELECT first_open_at, ended_at, end_reason, approved_at FROM session WHERE id = '${session}'`,
    )[0];
    expect(row?.first_open_at).not.toBeNull();
    expect(row).toMatchObject({ end_reason: "phone" });
  });

  it("records a guest upload with its source, and a hostile file name reaches the CSV neutralized (SITE-06 csv)", async () => {
    const { socket, pid } = await pairPhone(api);
    const res = await sendDrop(api, pid, validDeck(), { name: "=HYPERLINK(1).pptx" });
    expect(res.status).toBe(200);
    await socket.stateWhere((v) => v.state === "offered");
    await api.post("/api/end", {}, { auth: pid });

    const csv = await until(
      async () => (await get("?format=csv")).text(),
      (t) => t.includes("guest.uploaded") && t.includes("guest.deleted"),
    );
    const upload = csv.split("\r\n").find((l) => l.includes("guest.uploaded")) ?? "";
    expect(upload).toContain(",'=HYPERLINK(1).pptx,guest,");
    expect(csv.split("\r\n").some((l) => /^[=+\-@]/.test(l))).toBe(false);
    expect(csv).toContain("guest.deleted");
  });

  it("records the failure cause of a refused upload as a metric", async () => {
    const { pid } = await pairPhone(api);
    expect((await sendDrop(api, pid, "not a deck")).status).toBeGreaterThanOrEqual(400);
    const csv = await until(
      async () => (await get("?data=metrics&format=csv")).text(),
      (t) => t.includes("failure"),
    );
    expect(csv.split("\r\n")[0]).toBe("mode,name,cause,n,p50_ms,p90_ms");
    expect(csv).toMatch(/live,failure,[a-z_]+,1,,/);
  });
});

describe("metrics: scan to first open", () => {
  it("aggregates time to first open per mode through the export", async () => {
    const { socket, url } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    await fetchLink(url);
    const metrics = await until(
      async () => (await (await get("?data=metrics&format=json")).json()) as Row[],
      (m) => m.some((r) => r.name === "scan_to_open_ms"),
    );
    const open = metrics.find((r) => r.name === "scan_to_open_ms" && r.mode === "demo");
    expect(open?.n).toBeGreaterThanOrEqual(1);
    expect(open?.p50_ms).toEqual(expect.any(Number));
  });
});

describe("SITE-07 export-auth: one bearer token, compared by hash", () => {
  it.each([
    ["no token", null],
    ["a wrong token", "wrong-token-wrong-token-wrong-token-00"],
    ["a token of another length", "x"],
  ])("refuses %s with 401 and no data", async (_name, token) => {
    const res = await get("?format=json", token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ type: "about:blank", status: 401, code: "unauthorized" });
  });

  it("accepts the token and sends strict headers, a download name and no caching", async () => {
    const res = await get("?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="bloop-audit-.*\.csv"$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("Strict-Transport-Security")).not.toBeNull();
    await res.text();
  });

  it("records every run as an export.run row naming the data, the format and the range", async () => {
    await (await get("?format=json&from=2026-01-01&to=2026-01-31")).text();
    const all = await rows();
    const run = all.find((e) => e.type === "export.run" && e.reason === "2026-01-01..2026-01-31");
    expect(run).toMatchObject({ actor: "it", purpose: "audit.json", mode: null });
  });

  it("refuses a bad format, data kind or range with 400, and a non-GET with 405", async () => {
    for (const q of [
      "?format=xml",
      "?format=toString",
      "?format=__proto__",
      "?data=files",
      "?from=nope",
      "?from=2026-02-01&to=2026-01-01",
      "?from=2020-01-01",
    ]) {
      expect((await get(q)).status, q).toBe(400);
    }
    const post = await fetch(exportUrl(), { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(post.status).toBe(405);
  });

  it("bounds the range: rows outside it are not returned", async () => {
    const none = await rows("&from=2001-01-01&to=2001-01-02");
    expect(none).toEqual([]);
  });
});

describe("SITE-07 export-auth: the export is closed without a configured token, and rate limited", () => {
  it("answers 401 whatever is presented when IT_EXPORT_TOKEN is unset, then 429 past RL_EXPORT", async () => {
    const closed = await startWrangler({ HASH_PEPPER: PEPPER, IT_EXPORT_TOKEN: "" }, { migrate: true });
    try {
      const ip = { "CF-Connecting-IP": "203.0.113.80" };
      const statuses: number[] = [];
      await inOneWindow();
      for (let i = 0; i < 14; i++) {
        const res = await fetch(`${closed.url}/api/it/export`, {
          headers: { ...ip, Authorization: "Bearer anything" },
        });
        statuses.push(res.status);
        await res.text();
      }
      expect(statuses.indexOf(429)).toBe(10);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      const other = await fetch(`${closed.url}/api/it/export`, { headers: { "CF-Connecting-IP": "203.0.113.81" } });
      expect(other.status).toBe(401);
    } finally {
      await closed.stop();
    }
  });
});
