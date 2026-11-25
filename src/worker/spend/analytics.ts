// What bloop cannot count itself (presigned R2 PUTs, Worker and Durable Object requests, D1 rows) comes from
// Cloudflare's GraphQL Analytics API. One query per dataset, so one wrong field name costs one reading, not all of
// them. The dataset and field names below are unverified against a live token (docs/spend.md says so).

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
/** Durable Object duration bills wall-clock at 128 MB: 0.125 GB per second awake. */
const DO_GB_PER_SECOND = 0.125;

export interface Readings {
  workersRequests?: number;
  workersErrors?: number;
  /** Mean requests per day over the 7 full UTC days before today. */
  workersRequests7dMean?: number;
  doRequests?: number;
  doGbSeconds?: number;
  r2ClassA?: number;
  r2ClassB?: number;
  r2StorageBytes?: number;
  d1RowsWritten?: number;
}

export interface AnalyticsResult {
  readings: Readings;
  /** Datasets whose read failed, with the reason; their readings are absent. */
  failed: { dataset: string; error: string }[];
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

async function gql(
  deps: AnalyticsDeps,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const res = await deps.fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: deps.accountId, ...variables } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const body = (await res.json()) as {
    data?: { viewer?: { accounts?: Record<string, unknown>[] } };
    errors?: { message?: string }[];
  };
  if (body.errors?.length) throw new Error(String(body.errors[0]?.message ?? "graphql error").slice(0, 200));
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("no account in response");
  return [account];
}

const sum = (rows: unknown, pick: (row: Record<string, any>) => number): number =>
  (Array.isArray(rows) ? rows : []).reduce(
    (total: number, row) => total + (Number(pick(row as Record<string, any>)) || 0),
    0,
  );

type Reader = (deps: AnalyticsDeps) => Promise<Readings>;

const readers: Record<string, Reader> = {
  async workers(deps) {
    const today = dayStart(deps.now);
    const [account] = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!, $weekFrom: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          today: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { requests errors } }
          week: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $weekFrom, datetime_lt: $from}) { sum { requests } }
        } }
      }`,
      { from: iso(today), to: iso(deps.now), weekFrom: iso(today - 7 * DAY_MS) },
    );
    const a = account as { today?: unknown; week?: unknown };
    return {
      workersRequests: sum(a.today, (r) => r.sum?.requests),
      workersErrors: sum(a.today, (r) => r.sum?.errors),
      workersRequests7dMean: sum(a.week, (r) => r.sum?.requests) / 7,
    };
  },
  async durableObjects(deps) {
    const [account] = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          requests: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { requests } }
          active: durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { activeTime } }
        } }
      }`,
      { from: iso(dayStart(deps.now)), to: iso(deps.now) },
    );
    const a = account as { requests?: unknown; active?: unknown };
    return {
      doRequests: sum(a.requests, (r) => r.sum?.requests),
      // activeTime is microseconds.
      doGbSeconds: (sum(a.active, (r) => r.sum?.activeTime) / 1_000_000) * DO_GB_PER_SECOND,
    };
  },
  async r2Operations(deps) {
    const [account] = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $from, datetime_leq: $to}) {
            sum { requests } dimensions { actionType }
          }
        } }
      }`,
      { from: iso(dayStart(deps.now)), to: iso(deps.now) },
    );
    const rows = (account as { ops?: unknown }).ops;
    const total = (set: Set<string>) =>
      sum(rows, (r) => (set.has(String(r.dimensions?.actionType)) ? Number(r.sum?.requests) : 0));
    return { r2ClassA: total(R2_CLASS_A), r2ClassB: total(R2_CLASS_B) };
  },
  async r2Storage(deps) {
    const [account] = await gql(
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
    const newest = new Map<string, Record<string, any>>();
    for (const row of ((account as { storage?: unknown[] }).storage ?? []) as Record<string, any>[]) {
      const bucket = String(row.dimensions?.bucketName);
      if (!newest.has(bucket)) newest.set(bucket, row);
    }
    return {
      r2StorageBytes: sum([...newest.values()], (r) => Number(r.max?.payloadSize) + Number(r.max?.metadataSize)),
    };
  },
  async d1(deps) {
    const [account] = await gql(
      deps,
      `query ($account: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: {accountTag: $account}) {
          d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: {datetime_geq: $from, datetime_leq: $to}) { sum { rowsWritten } }
        } }
      }`,
      { from: iso(dayStart(deps.now)), to: iso(deps.now) },
    );
    return { d1RowsWritten: sum((account as { d1?: unknown }).d1, (r) => r.sum?.rowsWritten) };
  },
};

/** Reads every dataset; a failing one is listed in `failed` and leaves its readings absent. Never throws. */
export async function readAnalytics(deps: AnalyticsDeps): Promise<AnalyticsResult> {
  const settled = await Promise.allSettled(Object.values(readers).map((read) => read(deps)));
  const readings: Readings = {};
  const failed: AnalyticsResult["failed"] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") Object.assign(readings, outcome.value);
    else
      failed.push({
        dataset: Object.keys(readers)[i] as string,
        error: outcome.reason instanceof Error ? outcome.reason.message : "failed",
      });
  });
  return { readings, failed };
}
