import { describe, expect, it } from "vitest";
import { type AnalyticsResult, dayValue, readAnalytics, readingsOf } from "../../src/worker/spend/analytics.ts";
import { T0 } from "./spend-helpers.ts";

type Body = { query: string; variables: Record<string, string> };

/** Answers each dataset's query from `data`, keyed by a field name in the query; a missing key is a GraphQL error. */
function fakeApi(data: Record<string, unknown>, calls: Body[] = []): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    calls.push(body);
    const key = Object.keys(data).find((k) => body.query.includes(k));
    if (!key) return new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { status: 200 });
    return new Response(JSON.stringify({ data: { viewer: { accounts: [data[key]] } } }), { status: 200 });
  }) as typeof fetch;
}

const deps = (f: typeof fetch) => ({ token: "t0ken", accountId: "acct", now: T0, fetch: f });
const D = (date: string, sum: object, extra: object = {}) => ({ sum, dimensions: { date, ...extra } });

const FULL = {
  workersInvocationsAdaptive: {
    w: [D("2026-11-25", { requests: 120 }), D("2026-11-24", { requests: 700 }), D("2026-11-20", { requests: 700 })],
  },
  durableObjectsInvocationsAdaptiveGroups: {
    req: [D("2026-11-25", { requests: 55 })],
    active: [D("2026-11-25", { activeTime: 8_000_000 })],
  },
  r2OperationsAdaptiveGroups: {
    ops: [
      D("2026-11-25", { requests: 10 }, { actionType: "PutObject" }),
      D("2026-11-25", { requests: 5 }, { actionType: "UploadPart" }),
      D("2026-11-25", { requests: 7 }, { actionType: "GetObject" }),
      D("2026-11-24", { requests: 3 }, { actionType: "GetObject" }),
      D("2026-11-25", { requests: 99 }, { actionType: "DeleteObject" }),
    ],
  },
  r2StorageAdaptiveGroups: {
    storage: [
      { max: { payloadSize: 100, metadataSize: 5 }, dimensions: { bucketName: "a" } },
      { max: { payloadSize: 1, metadataSize: 1 }, dimensions: { bucketName: "a" } },
      { max: { payloadSize: 40, metadataSize: 0 }, dimensions: { bucketName: "b" } },
    ],
  },
  d1AnalyticsAdaptiveGroups: { d1: [D("2026-11-25", { rowsWritten: 321 }), D("2026-11-25", { rowsWritten: 9 })] },
};

describe("analytics client", () => {
  it("reads every dataset into daily series, summing rows that share a date and classing R2 actions", async () => {
    const calls: Body[] = [];
    const result = await readAnalytics(deps(fakeApi(FULL, calls)));
    expect(result.failed).toEqual([]);
    expect(result.daily).toEqual({
      workersRequests: { "2026-11-25": 120, "2026-11-24": 700, "2026-11-20": 700 },
      doRequests: { "2026-11-25": 55 },
      doGbSeconds: { "2026-11-25": 1 },
      r2ClassA: { "2026-11-25": 15 },
      r2ClassB: { "2026-11-25": 7, "2026-11-24": 3 },
      d1RowsWritten: { "2026-11-25": 330 },
    });
    expect(result.r2StorageBytes).toBe(145);
    expect(calls).toHaveLength(5);
    expect(calls[0]?.variables.account).toBe("acct");
    // A month of days back from today's start, to now.
    expect(calls[0]?.variables.from).toBe("2026-10-25T00:00:00.000Z");
    expect(calls[0]?.variables.to).toBe(new Date(T0).toISOString());
  });

  it("today's readings and the trailing 7-day mean come from the series", async () => {
    const result = await readAnalytics(deps(fakeApi(FULL)));
    expect(dayValue(result, "r2ClassB", T0)).toBe(7);
    expect(dayValue(result, "r2ClassA", T0 - 86_400_000 * 3)).toBe(0);
    expect(readingsOf(result, T0)).toEqual({
      workersRequests: 120,
      workersRequests7dMean: 200,
      doRequests: 55,
      doGbSeconds: 1,
    });
  });

  it("a series that was not read is undefined, not zero", () => {
    const none: AnalyticsResult = { daily: {}, failed: [] };
    expect(dayValue(none, "r2ClassA", T0)).toBeUndefined();
    expect(readingsOf(none, T0)).toEqual({});
  });

  it("one dataset failing leaves the rest, and names the failure without the token", async () => {
    const api = fakeApi({ d1AnalyticsAdaptiveGroups: FULL.d1AnalyticsAdaptiveGroups });
    const result = await readAnalytics(deps(api));
    expect(result.daily).toEqual({ d1RowsWritten: { "2026-11-25": 330 } });
    expect(result.failed.map((f) => f.dataset).sort()).toEqual([
      "durableObjects",
      "r2Operations",
      "r2Storage",
      "workers",
    ]);
    expect(JSON.stringify(result)).not.toContain("t0ken");
  });

  it("an http error, a network throw and an empty account are failures, never exceptions", async () => {
    for (const f of [
      (async () => new Response("no", { status: 403 })) as unknown as typeof fetch,
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }))) as unknown as typeof fetch,
    ]) {
      const result = await readAnalytics(deps(f));
      expect(result.failed).toHaveLength(5);
      expect(result.daily).toEqual({});
    }
  });

  it("sends the token as a bearer header to the GraphQL endpoint, once per dataset", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    await readAnalytics(deps(f));
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((s) => s.url))).toEqual(new Set(["https://api.cloudflare.com/client/v4/graphql"]));
    expect(new Set(seen.map((s) => s.auth))).toEqual(new Set(["Bearer t0ken"]));
  });
});
