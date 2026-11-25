// What bloop cannot count itself (presigned R2 PUTs, Worker and Durable Object requests, D1 rows) comes from
// Cloudflare's GraphQL Analytics API as daily totals. One query per dataset, so one wrong field name costs one
// series, not all of them. The dataset and field names below are unverified against a live token (docs/spend.md).

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
/** Days read: the longest month plus a day, which also covers the 14-day p95 window. */
export const ANALYTICS_DAYS = 32;
/** Durable Object duration bills wall-clock at 128 MB: 0.125 GB per second awake. */
const DO_GB_PER_SECOND = 0.125;

export type SeriesName = "workersRequests" | "doRequests" | "doGbSeconds" | "r2ClassA" | "r2ClassB" | "d1RowsWritten";
/** UTC date (`2026-11-25`) to that day's total. */
export type DailySeries = Record<string, number>;
export type Daily = Partial<Record<SeriesName, DailySeries>>;

export interface AnalyticsResult {
  daily: Daily;
  /** Newest bytes stored across the buckets. */
  r2StorageBytes?: number;
  /** Datasets whose read failed, with the reason; their series are absent. */
  failed: { dataset: string; error: string }[];
}

/** Today's figures and the trailing mean, in the shape the rules read. */
export interface Readings {
  workersRequests?: number;
  /** Mean requests per day over the 7 full UTC days before today. */
  workersRequests7dMean?: number;
  doRequests?: number;
  doGbSeconds?: number;
  r2ClassA?: number;
  r2ClassB?: number;
  r2StorageBytes?: number;
  d1RowsWritten?: number;
}

export interface AnalyticsDeps {
  token: string;
  accountId: string;
  now: number;
  fetch: typeof fetch;
}

// R2 bills these as class A; HeadObject and GetObject as class B; deletes and aborts are free.
const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

const dayStart = (at: number) => at - (at % DAY_MS);
const iso = (at: number) => new Date(at).toISOString();
export const dateKey = (at: number) => iso(at).slice(0, 10);

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v) || 0;
const sub = (row: Row, key: string, field: string) => num(((row[key] ?? {}) as Row)[field]);
const dim = (row: Row, field: string) => String(((row.dimensions ?? {}) as Row)[field]);

async function gql(deps: AnalyticsDeps, query: string, variables: Record<string, unknown>): Promise<Row> {
  const res = await deps.fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: deps.accountId, ...variables } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const body = (await res.json()) as {
    data?: { viewer?: { accounts?: Row[] } };
    errors?: { message?: string }[];
  };
  if (body.errors?.length) throw new Error(String(body.errors[0]?.message ?? "graphql error").slice(0, 200));
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("no account in response");
  return account;
}

const window = (deps: AnalyticsDeps) => ({
  from: iso(dayStart(deps.now) - (ANALYTICS_DAYS - 1) * DAY_MS),
  to: iso(deps.now),
});

function add(series: DailySeries, date: string, value: number): void {
  series[date] = (series[date] ?? 0) + value;
}

const rows = (account: Row, key: string): Row[] => (Array.isArray(account[key]) ? (account[key] as Row[]) : []);

type Read = Daily & { r2StorageBytes?: number };
type Reader = (deps: AnalyticsDeps) => Promise<Read>;

const readers: Record<string, Reader> = {
  async workers(deps) {
    const account = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          w: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { requests } dimensions { date } }
        } }
      }`,
      window(deps),
    );
    const s: DailySeries = {};
    for (const r of rows(account, "w")) add(s, dim(r, "date"), sub(r, "sum", "requests"));
    return { workersRequests: s };
  },
  async durableObjects(deps) {
    const account = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          req: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { requests } dimensions { date } }
          active: durableObjectsPeriodicGroups(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { activeTime } dimensions { date } }
        } }
      }`,
      window(deps),
    );
    const requests: DailySeries = {};
    const gbSeconds: DailySeries = {};
    for (const r of rows(account, "req")) add(requests, dim(r, "date"), sub(r, "sum", "requests"));
    // activeTime is microseconds.
    for (const r of rows(account, "active"))
      add(gbSeconds, dim(r, "date"), (sub(r, "sum", "activeTime") / 1_000_000) * DO_GB_PER_SECOND);
    return { doRequests: requests, doGbSeconds: gbSeconds };
  },
  async r2Operations(deps) {
    const account = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}) {
            sum { requests } dimensions { date actionType }
          }
        } }
      }`,
      window(deps),
    );
    const a: DailySeries = {};
    const b: DailySeries = {};
    for (const r of rows(account, "ops")) {
      const action = dim(r, "actionType");
      if (R2_CLASS_A.has(action)) add(a, dim(r, "date"), sub(r, "sum", "requests"));
      else if (R2_CLASS_B.has(action)) add(b, dim(r, "date"), sub(r, "sum", "requests"));
    }
    return { r2ClassA: a, r2ClassB: b };
  },
  async r2Storage(deps) {
    const account = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          storage: r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}, orderBy: [datetime_DESC]) {
            max { payloadSize metadataSize } dimensions { datetime bucketName }
          }
        } }
      }`,
      { from: iso(deps.now - DAY_MS), to: iso(deps.now) },
    );
    // The newest sample of each bucket.
    const newest = new Map<string, Row>();
    for (const r of rows(account, "storage"))
      if (!newest.has(dim(r, "bucketName"))) newest.set(dim(r, "bucketName"), r);
    let bytes = 0;
    for (const r of newest.values()) bytes += sub(r, "max", "payloadSize") + sub(r, "max", "metadataSize");
    return { r2StorageBytes: bytes };
  },
  async d1(deps) {
    const account = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { rowsWritten } dimensions { date } }
        } }
      }`,
      window(deps),
    );
    const s: DailySeries = {};
    for (const r of rows(account, "d1")) add(s, dim(r, "date"), sub(r, "sum", "rowsWritten"));
    return { d1RowsWritten: s };
  },
};

/** Reads every dataset; a failing one is listed in `failed` and leaves its series absent. Never throws. */
export async function readAnalytics(deps: AnalyticsDeps): Promise<AnalyticsResult> {
  const settled = await Promise.allSettled(Object.values(readers).map((read) => read(deps)));
  const out: AnalyticsResult = { daily: {}, failed: [] };
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      const { r2StorageBytes, ...series } = outcome.value;
      Object.assign(out.daily, series);
      if (r2StorageBytes !== undefined) out.r2StorageBytes = r2StorageBytes;
    } else
      out.failed.push({
        dataset: Object.keys(readers)[i] as string,
        error: outcome.reason instanceof Error ? outcome.reason.message : "failed",
      });
  });
  return out;
}

/** The value of a series on `at`'s UTC day; undefined when the series was not read. */
export function dayValue(result: AnalyticsResult, name: SeriesName, at: number): number | undefined {
  const series = result.daily[name];
  return series === undefined ? undefined : (series[dateKey(at)] ?? 0);
}

/** Today's figures and the trailing 7-day mean, for the rules that read one day at a time. */
export function readingsOf(result: AnalyticsResult, now: number): Readings {
  const out: Readings = {};
  for (const name of [
    "workersRequests",
    "doRequests",
    "doGbSeconds",
    "r2ClassA",
    "r2ClassB",
    "d1RowsWritten",
  ] as const) {
    const v = dayValue(result, name, now);
    if (v !== undefined) out[name] = v;
  }
  const w = result.daily.workersRequests;
  if (w) {
    let total = 0;
    for (let i = 1; i <= 7; i++) total += w[dateKey(now - i * DAY_MS)] ?? 0;
    out.workersRequests7dMean = total / 7;
  }
  if (result.r2StorageBytes !== undefined) out.r2StorageBytes = result.r2StorageBytes;
  return out;
}
