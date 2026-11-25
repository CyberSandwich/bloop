import { describe, expect, it } from "vitest";
import { readAnalytics } from "../../src/worker/spend/analytics.ts";
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

describe("analytics client", () => {
  it("reads every dataset into one set of readings", async () => {
    const calls: Body[] = [];
    const api = fakeApi(
      {
        workersInvocationsAdaptive: {
          today: [{ sum: { requests: 120, errors: 3 } }],
          week: [{ sum: { requests: 700 } }],
        },
        durableObjectsInvocationsAdaptiveGroups: {
          requests: [{ sum: { requests: 55 } }],
          active: [{ sum: { activeTime: 8_000_000 } }],
        },
        r2OperationsAdaptiveGroups: {
          ops: [
            { sum: { requests: 10 }, dimensions: { actionType: "PutObject" } },
            { sum: { requests: 5 }, dimensions: { actionType: "UploadPart" } },
            { sum: { requests: 7 }, dimensions: { actionType: "GetObject" } },
            { sum: { requests: 99 }, dimensions: { actionType: "DeleteObject" } },
          ],
        },
        r2StorageAdaptiveGroups: {
          storage: [
            { max: { payloadSize: 100, metadataSize: 5 }, dimensions: { bucketName: "a" } },
            { max: { payloadSize: 1, metadataSize: 1 }, dimensions: { bucketName: "a" } },
            { max: { payloadSize: 40, metadataSize: 0 }, dimensions: { bucketName: "b" } },
          ],
        },
        d1AnalyticsAdaptiveGroups: { d1: [{ sum: { rowsWritten: 321 } }] },
      },
      calls,
    );
    const result = await readAnalytics(deps(api));
    expect(result.failed).toEqual([]);
    expect(result.readings).toEqual({
      workersRequests: 120,
      workersErrors: 3,
      workersRequests7dMean: 100,
      doRequests: 55,
      doGbSeconds: 1,
      r2ClassA: 15,
      r2ClassB: 7,
      r2StorageBytes: 145,
      d1RowsWritten: 321,
    });
    expect(calls).toHaveLength(5);
    expect(calls[0]?.variables.account).toBe("acct");
    expect(calls[0]?.variables.from).toBe("2026-11-25T00:00:00.000Z");
  });

  it("one dataset failing leaves the rest, and names the failure without the token", async () => {
    const api = fakeApi({ d1AnalyticsAdaptiveGroups: { d1: [{ sum: { rowsWritten: 9 } }] } });
    const result = await readAnalytics(deps(api));
    expect(result.readings).toEqual({ d1RowsWritten: 9 });
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
      expect(result.readings).toEqual({});
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
