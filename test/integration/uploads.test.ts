// /api/uploads against a real wrangler dev: local D1, local R2 (the library bucket), the spend guard Durable Object.
// Sessions are seeded straight into D1 (a member's cookie), as the account tests do.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concat, validVideo } from "../zip-builder.ts";
import { inOneWindow } from "./open-client.ts";
import { startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const PART = 16 * MIB;
let wrangler: Wrangler;

beforeAll(async () => {
  wrangler = await startPairing({ LIBRARY_MAX_FILE_BYTES: String(2 * GIB), UPLOAD_MODE: "proxy" }, { migrate: true });
}, 120_000);
afterAll(async () => {
  await wrangler?.stop();
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (seed: string) => sha(seed);

function member(id: string): string {
  const cookie = id.padEnd(43, "x");
  const now = Date.now();
  wrangler.d1(
    `INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('${id}', 'email', '${id}', '${id}@example.test', '${id}@example.test', 0, 0)`,
  );
  wrangler.d1(
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('${sha(cookie)}', '${id}', ${now}, ${now}, ${now + 86_400_000})`,
  );
  return cookie;
}

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const res = await fetch(`${wrangler.url}${path}`, {
    method,
    headers: {
      Origin: wrangler.url,
      ...(cookie ? { Cookie: `__Host-bloop_sid=${cookie}` } : {}),
      ...(method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(method === "GET" || body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

const putPart = (cookie: string, uploadId: string, n: number, bytes: Uint8Array) =>
  fetch(`${wrangler.url}/api/uploads/${uploadId}/parts/${n}`, {
    method: "PUT",
    headers: { Origin: wrangler.url, Cookie: `__Host-bloop_sid=${cookie}`, "Content-Type": "application/octet-stream" },
    body: bytes,
  });

interface Created {
  uploadId: string;
  fileId: string;
  partBytes: number;
  parts: number;
  done: number[];
  urls: { n: number; url: string }[];
}

const deck = (name: string, size = 64) => ({ name, bytes: validVideo("isom", size) });
const createOf = (cookie: string, name: string, bytes: Uint8Array, seed: string, headers = {}) =>
  call<Created>(cookie, "POST", "/api/uploads", { name, bytes: bytes.length, fingerprint: fingerprint(seed) }, headers);

const counters = (id: string) =>
  wrangler.d1(`SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = '${id}'`)[0];

describe("who may call", () => {
  it("answers 401 to every route without a member session", async () => {
    for (const [method, path] of [
      ["GET", "/api/uploads"],
      ["POST", "/api/uploads"],
      ["POST", "/api/uploads/x/urls"],
      ["PUT", "/api/uploads/x/parts/1"],
      ["POST", "/api/uploads/x/parts/1/done"],
      ["POST", "/api/uploads/x/complete"],
      ["GET", "/api/uploads/x"],
      ["DELETE", "/api/uploads/x"],
    ] as const) {
      expect(
        (await call(null, method, path, method === "GET" || method === "DELETE" ? undefined : {})).status,
        `${method} ${path}`,
      ).toBe(401);
    }
  });

  it("UP-03 owner: another member's upload id is the same 404 as an unknown one on every id route", async () => {
    const owner = member("up3-owner");
    const other = member("up3-other");
    const { bytes } = deck("a.mp4");
    const made = await createOf(owner, "a.mp4", bytes, "up3");
    expect(made.status).toBe(201);
    const id = made.body.uploadId;
    for (const [method, path, body] of [
      ["POST", "urls", { parts: [1] }],
      ["PUT", "parts/1", undefined],
      ["POST", "parts/1/done", { etag: "a".repeat(32), bytes: bytes.length }],
      ["POST", "complete", {}],
      ["GET", "", undefined],
      ["DELETE", "", undefined],
    ] as const) {
      const route = `/api/uploads/${id}${path ? `/${path}` : ""}`;
      const unknown = `/api/uploads/${"0".repeat(id.length)}${path ? `/${path}` : ""}`;
      const foreign = await call(other, method, route, body);
      const missing = await call(other, method, unknown, body);
      expect(foreign.status, `${method} ${route}`).toBe(404);
      expect(foreign.body, `${method} ${route}`).toEqual(missing.body);
    }
    expect(counters("up3-owner")?.reserved).toBe(bytes.length);
    expect(wrangler.d1(`SELECT count(*) AS n FROM upload WHERE id = '${id}' AND aborted_at IS NULL`)[0]?.n).toBe(1);
  });
});

describe("the small file path", () => {
  it("creates, stores a part, completes and leaves a ready file; the part route needs the exact length", async () => {
    const cookie = member("small1");
    const { bytes } = deck("clip.mp4");
    const made = await createOf(cookie, "clip.mp4", bytes, "small1");
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ parts: 1, partBytes: PART, done: [] });
    expect(made.body.urls[0]?.url).toBe(`/api/uploads/${made.body.uploadId}/parts/1`);

    const wrong = await putPart(cookie, made.body.uploadId, 1, bytes.subarray(1));
    expect(wrong.status).toBe(400);
    const stored = await putPart(cookie, made.body.uploadId, 1, bytes);
    expect(stored.status).toBe(200);

    const done = await call<{ state: string; file: { id: string; status: string } }>(
      cookie,
      "POST",
      `/api/uploads/${made.body.uploadId}/complete`,
      {},
    );
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "ready", file: { id: made.body.fileId, status: "ready" } });
    expect(counters("small1")).toEqual({ used: bytes.length, reserved: 0 });
    const [file] = wrangler.d1(
      "SELECT status, ext, length(sha256) AS shaLen FROM library_file WHERE id = '" + made.body.fileId + "'",
    );
    expect(file).toMatchObject({ status: "ready", ext: "mp4", shaLen: 64 });

    const state = await call<{ state: string }>(cookie, "GET", `/api/uploads/${made.body.uploadId}`);
    expect(state.body.state).toBe("completed");
  });

  it("REL-14 idem: the same key and body replays the first answer, another body is refused, a new key resumes", async () => {
    const cookie = member("idem1");
    const { bytes } = deck("idem.mp4");
    const key = randomUUID();
    const first = await createOf(cookie, "idem.mp4", bytes, "idem", { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const replay = await createOf(cookie, "idem.mp4", bytes, "idem", { "Idempotency-Key": key });
    expect(replay.status).toBe(200);
    expect(replay.body.uploadId).toBe(first.body.uploadId);
    const clash = await createOf(cookie, "idem.mp4", bytes, "idem-other", { "Idempotency-Key": key });
    expect(clash.status).toBe(400);
    const fresh = await createOf(cookie, "idem.mp4", bytes, "idem", { "Idempotency-Key": randomUUID() });
    expect(fresh.status).toBe(200);
    expect(fresh.body.uploadId).toBe(first.body.uploadId);
    expect((await createOf(cookie, "idem.mp4", bytes, "idem", { "Idempotency-Key": "not-a-uuid" })).status).toBe(400);
    expect(wrangler.d1("SELECT count(*) AS n FROM upload WHERE user_id = 'idem1'")[0]?.n).toBe(1);
    expect(counters("idem1")?.reserved).toBe(bytes.length);
  });

  it("UP-04 abort: DELETE cancels, returns the reservation and a repeat is a no-op", async () => {
    const cookie = member("abort1");
    const { bytes } = deck("gone.mp4");
    const made = await createOf(cookie, "gone.mp4", bytes, "abort1");
    expect(counters("abort1")?.reserved).toBe(bytes.length);
    expect((await call(cookie, "DELETE", `/api/uploads/${made.body.uploadId}`)).status).toBe(204);
    expect(counters("abort1")).toEqual({ used: 0, reserved: 0 });
    expect((await call(cookie, "DELETE", `/api/uploads/${made.body.uploadId}`)).status).toBe(204);
    const part = await putPart(cookie, made.body.uploadId, 1, bytes);
    expect(part.status).toBe(410);
  });

  it("UP-05 type: a name that declares a type the bytes are not is refused and costs no quota", async () => {
    const cookie = member("type1");
    const bytes = new TextEncoder().encode("MZ not a deck at all");
    const made = await createOf(cookie, "deck.pptx", bytes, "type1");
    expect(made.status).toBe(201);
    expect((await putPart(cookie, made.body.uploadId, 1, bytes)).status).toBe(200);
    const done = await call<{ state: string; file: { status: string } }>(
      cookie,
      "POST",
      `/api/uploads/${made.body.uploadId}/complete`,
      {},
    );
    expect(done.body).toMatchObject({ state: "refused", file: { status: "refused" } });
    expect(counters("type1")).toEqual({ used: 0, reserved: 0 });
    expect((await createOf(cookie, "run.exe", bytes, "type1b")).body).toMatchObject({ code: "bad_type" });
  });

  it("UP-08 resume: the complete body takes no part list, only the last part's own report", async () => {
    const cookie = member("resume1");
    const { bytes } = deck("r.mp4");
    const made = await createOf(cookie, "r.mp4", bytes, "resume1");
    const path = `/api/uploads/${made.body.uploadId}/complete`;
    expect((await call(cookie, "POST", path, { parts: [{ n: 1, etag: "a".repeat(32) }] })).status).toBe(400);
    expect((await call(cookie, "POST", path, { n: 1, etag: "zz", bytes: bytes.length })).status).toBe(400);
    expect(counters("resume1")?.reserved).toBe(bytes.length);
  });
});

describe("the switches and the refusal paths", () => {
  it("W10: with uploads off or readonly a create is refused 503 and no row or R2 upload is written", async () => {
    const cookie = member("sw1");
    const { bytes } = deck("sw.mp4");
    for (const value of ["readonly", "off"]) {
      wrangler.d1(`INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('uploads', '${value}', 0)`);
      const refused = await createOf(cookie, "sw.mp4", bytes, `sw-${value}`);
      expect(refused.status, value).toBe(503);
      expect(refused.body).toMatchObject({ code: "service_busy" });
    }
    expect(wrangler.d1("SELECT count(*) AS n FROM upload WHERE user_id = 'sw1'")[0]?.n).toBe(0);
    expect(counters("sw1")).toEqual({ used: 0, reserved: 0 });
    wrangler.d1("DELETE FROM setting WHERE key = 'uploads'");
  });

  it("readonly still lets a started upload finish, and off still lets it cancel and be read", async () => {
    const cookie = member("sw2");
    const { bytes } = deck("sw2.mp4");
    const made = await createOf(cookie, "sw2.mp4", bytes, "sw2");
    wrangler.d1("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('uploads', 'readonly', 0)");
    expect((await putPart(cookie, made.body.uploadId, 1, bytes)).status).toBe(200);
    expect((await call(cookie, "POST", `/api/uploads/${made.body.uploadId}/urls`, { parts: [1] })).status).toBe(503);
    wrangler.d1("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('uploads', 'off', 0)");
    expect((await putPart(cookie, made.body.uploadId, 1, bytes)).status).toBe(503);
    expect((await call(cookie, "GET", `/api/uploads/${made.body.uploadId}`)).status).toBe(200);
    expect((await call(cookie, "DELETE", `/api/uploads/${made.body.uploadId}`)).status).toBe(204);
    expect(counters("sw2")).toEqual({ used: 0, reserved: 0 });
    wrangler.d1("DELETE FROM setting WHERE key = 'uploads'");
  });

  it("refuses a body that is not the guard's: wrong origin, wrong content type, extra fields", async () => {
    const cookie = member("guard1");
    const body = { name: "a.mp4", bytes: 10, fingerprint: fingerprint("guard1") };
    const wrongOrigin = await fetch(`${wrangler.url}/api/uploads`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: `__Host-bloop_sid=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(wrongOrigin.status).toBe(403);
    const form = await fetch(`${wrangler.url}/api/uploads`, {
      method: "POST",
      headers: { Origin: wrangler.url, Cookie: `__Host-bloop_sid=${cookie}`, "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    });
    expect(form.status).toBe(415);
    expect((await call(cookie, "POST", "/api/uploads", { ...body, extra: 1 })).status).toBe(400);
    expect((await call(cookie, "POST", "/api/uploads", { ...body, bytes: 0 })).status).toBe(400);
    expect((await call(cookie, "POST", "/api/uploads", { ...body, fingerprint: "XYZ" })).status).toBe(400);
    expect(wrangler.d1("SELECT count(*) AS n FROM upload WHERE user_id = 'guard1'")[0]?.n).toBe(0);
  });
});

describe("LIB-02 race: the quota under concurrent creates", () => {
  it("LIB-02 race: twelve 1 GiB creates against a 5 GiB quota admit exactly five", async () => {
    await inOneWindow();
    const cookie = member("race1");
    const sizes = Array.from({ length: 12 }, (_, i) => i);
    const replies = await Promise.all(
      sizes.map((i) =>
        call(cookie, "POST", "/api/uploads", {
          name: `race${i}.mp4`,
          bytes: GIB,
          fingerprint: fingerprint(`race-${i}`),
        }),
      ),
    );
    const admitted = replies.filter((r) => r.status === 201);
    const refused = replies.filter((r) => r.status !== 201);
    expect(admitted).toHaveLength(5);
    expect(refused.map((r) => (r.body as { code: string }).code)).toEqual(Array(7).fill("quota_exceeded"));
    expect(counters("race1")).toEqual({ used: 0, reserved: 5 * GIB });
    expect(wrangler.d1("SELECT count(*) AS n FROM upload WHERE user_id = 'race1'")[0]?.n).toBe(5);
  });
});

describe("the large file path", () => {
  it("proxy mode: 450 MiB in 29 parts, interrupted after part 10, resumed and completed; the quota is exact", async () => {
    const cookie = member("big1");
    const total = 450 * MIB;
    const head = validVideo("isom", 0);
    const payload = total - head.length;
    const file = concat([head, new Uint8Array(payload)]);
    new DataView(file.buffer, file.byteOffset, file.byteLength).setUint32(head.length - 8, 8 + payload);
    expect(file.length).toBe(total);

    const made = await createOf(cookie, "big.mp4", file, "big1");
    expect(made.status).toBe(201);
    expect(made.body.parts).toBe(29);
    const send = async (id: string, n: number) => {
      const part = file.subarray((n - 1) * PART, Math.min(total, n * PART));
      const res = await putPart(cookie, id, n, part);
      expect(res.status, `part ${n}`).toBe(200);
    };
    for (let n = 1; n <= 10; n++) await send(made.body.uploadId, n);

    const resumed = await createOf(cookie, "big.mp4", file, "big1");
    expect(resumed.status).toBe(200);
    expect(resumed.body.uploadId).toBe(made.body.uploadId);
    expect(resumed.body.done).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(resumed.body.urls.map((u) => u.n)[0]).toBe(11);
    for (let n = 11; n <= 29; n++) await send(made.body.uploadId, n);

    const done = await call<{ state: string }>(cookie, "POST", `/api/uploads/${made.body.uploadId}/complete`, {});
    expect(done.body.state).toBe("ready");
    expect(counters("big1")).toEqual({ used: 471_859_200, reserved: 0 });
  }, 600_000);
});

describe("the sweep", () => {
  it("UP-04 abort: the hourly cron aborts an expired upload and returns its reservation", async () => {
    const cookie = member("sweep1");
    const { bytes } = deck("sweep.mp4");
    const made = await createOf(cookie, "sweep.mp4", bytes, "sweep1");
    wrangler.d1(`UPDATE upload SET expires_at = 1 WHERE id = '${made.body.uploadId}'`);
    const res = await fetch(`${wrangler.url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 * * * *")}`);
    expect(res.status).toBe(200);
    expect(counters("sweep1")).toEqual({ used: 0, reserved: 0 });
    expect(
      wrangler.d1(`SELECT aborted_at IS NOT NULL AS closed FROM upload WHERE id = '${made.body.uploadId}'`)[0]?.closed,
    ).toBe(1);
  });
});
