// The real upload engine (public/js/core/upload.js) against the real routes under `wrangler dev`, proxy mode. The unit
// tests drive the engine against a fake server; this is the guard that the fake cannot drift from the routes: whatever
// the engine sends here, the Worker's strict bodies, length rules and quota accept or refuse as in production.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUploader } from "../../public/js/core/upload.js";
import { validDeck, validVideo } from "../zip-builder.ts";
import { pairPhone, sendDrop } from "./drop-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const MIB = 1024 * 1024;
const PART = 5 * MIB;
const STAMP = 1_700_000_000_000;
let wrangler: Wrangler;
/** A second server whose class B cap is below a large file's read budget, so its check stays `checking`. */
let stuck: Wrangler;
// transitional: A limits option. These two servers and the midnight wait below go when startWrangler takes `limits`.
/** One upload an account may start a day: the second is answered 429, with a Retry-After far beyond a wait. */
let limited: Wrangler;
/** One file in a library: the second is answered 409 library_full. */
let crowded: Wrangler;

beforeAll(async () => {
  const vars = { LIBRARY_MAX_FILE_BYTES: String(512 * MIB), UPLOAD_MODE: "proxy", UPLOAD_PART_BYTES: String(PART) };
  [wrangler, stuck, limited, crowded] = await Promise.all([
    startPairing(vars, { migrate: true }),
    startPairing({ ...vars, CAP_R2_CLASS_B_MONTH: "3" }, { migrate: true }),
    startPairing({ ...vars, CAP_UPLOAD_USER_DAY: "1" }, { migrate: true }),
    startPairing({ ...vars, LIBRARY_MAX_FILES: "1" }, { migrate: true }),
  ]);
}, 240_000);
afterAll(async () => {
  await Promise.all([wrangler?.stop(), stuck?.stop(), limited?.stop(), crowded?.stop()]);
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function member(server: Wrangler, id: string): string {
  const cookie = id.padEnd(43, "x");
  const now = Date.now();
  server.d1(
    `INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('${id}', 'email', '${id}', '${id}@example.test', '${id}@example.test', 0, 0)`,
  );
  server.d1(
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('${sha(cookie)}', '${id}', ${now}, ${now}, ${now + 86_400_000})`,
  );
  return cookie;
}

const mp4 = (name: string, payload: number) =>
  new File([validVideo("isom", payload) as never], name, { lastModified: STAMP });

interface Snap {
  id: number;
  state: string;
  error?: string;
  fileId?: string;
  uploadId?: string;
  loaded: number;
}
interface Batch {
  files: Snap[];
  active: boolean;
  fraction: number;
}

/** What the page's XMLHttpRequest does for the engine: a PUT with the member's cookie, answered by the Worker. */
function xhrFor(server: Wrangler, cookie: string, seen: string[]) {
  return class NodeXhr {
    method = "";
    url = "";
    headers: Record<string, string> = {};
    status = 0;
    responseText = "";
    res: Response | null = null;
    stop = new AbortController();
    upload = { onprogress: null as null | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) };
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onabort: null | (() => void) = null;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: Blob) {
      seen.push(`${this.method} ${this.url}`);
      fetch(`${server.url}${this.url}`, {
        method: this.method,
        headers: { ...this.headers, Origin: server.url, Cookie: `__Host-bloop_sid=${cookie}` },
        body,
        signal: this.stop.signal,
      })
        .then(async (res) => {
          this.res = res;
          this.status = res.status;
          this.responseText = await res.text();
          this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
          this.onload?.();
        })
        .catch((error: Error) => (error.name === "AbortError" ? this.onabort?.() : this.onerror?.()));
    }
    abort() {
      this.stop.abort();
    }
    getResponseHeader(name: string) {
      return this.res?.headers.get(name) ?? null;
    }
  };
}

/** The engine, wired to a server as the page wires it: the member's cookie on every request, nothing else faked. */
function engine(
  server: Wrangler,
  cookie: string,
  onBatch: (b: Batch, up: ReturnType<typeof createUploader>) => void = () => {},
) {
  const requests: string[] = [];
  const parts: string[] = [];
  const snaps: Batch[] = [];
  let finish: (b: Batch) => void = () => {};
  const done = new Promise<Batch>((resolve) => {
    finish = resolve;
  });
  const Xhr = xhrFor(server, cookie, parts);
  const up: ReturnType<typeof createUploader> = createUploader({
    onChange: (b) => {
      const batch = structuredClone(b) as Batch;
      snaps.push(batch);
      onBatch(batch, up);
      if (batch.files.length && !batch.active) finish(batch);
    },
    deps: {
      fetch: (path: string, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${path}`);
        return fetch(`${server.url}${path}`, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            Origin: server.url,
            Cookie: `__Host-bloop_sid=${cookie}`,
          },
        });
      },
      xhr: () => new Xhr() as never,
      win: { addEventListener() {}, removeEventListener() {}, location: { origin: server.url } },
      doc: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
      wakeLock: undefined,
      vibrate: undefined,
    } as never,
  });
  return { up, snaps, done, requests, parts };
}

const rows = (server: Wrangler, sql: string) => server.d1(sql);
const counters = (server: Wrangler, id: string) =>
  rows(server, `SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = '${id}'`)[0];
const until = async (what: string, ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("the engine against the real routes", () => {
  it("a single part: created, sent through the Worker, completed, Saved with the server's file", async () => {
    const cookie = member(wrangler, "ec-single");
    const file = mp4("clip.mp4", 64);
    const run = engine(wrangler, cookie);
    run.up.add([file]);
    const last = await run.done;
    expect(last.files[0]).toMatchObject({ state: "saved" });
    const states = run.snaps.map((b) => b.files[0]?.state);
    expect(states.indexOf("checking")).toBeLessThan(states.lastIndexOf("saved"));
    expect(run.parts).toHaveLength(1);
    expect(run.requests.filter((r) => r.endsWith("/done"))).toEqual([]);
    const [row] = rows(wrangler, "SELECT id, status FROM library_file WHERE user_id = 'ec-single'");
    expect(row).toMatchObject({ status: "ready" });
    expect(last.files[0]?.fileId).toBe(row?.id);
    expect(counters(wrangler, "ec-single")).toEqual({ used: file.size, reserved: 0 });
  }, 60_000);

  it("over 8 parts: every part is sent, URLs beyond the first 8 are minted with a strict body, and the fill never goes back", async () => {
    const cookie = member(wrangler, "ec-multi");
    const file = mp4("long.mp4", 43 * MIB);
    const run = engine(wrangler, cookie);
    run.up.add([file]);
    const last = await run.done;
    expect(last.files[0]).toMatchObject({ state: "saved" });
    const parts = Number(rows(wrangler, "SELECT parts FROM upload WHERE user_id = 'ec-multi'")[0]?.parts);
    expect(parts).toBeGreaterThan(8);
    expect(run.parts).toHaveLength(parts);
    expect(run.requests.filter((r) => r.endsWith("/urls"))).not.toEqual([]);
    const fills = run.snaps.map((b) => b.fraction);
    expect(fills).toEqual([...fills].sort((a, b) => a - b));
    expect(counters(wrangler, "ec-multi")).toEqual({ used: file.size, reserved: 0 });
  }, 120_000);

  it("resume: a page that went away mid upload finishes it from the server's parts, sending only the rest", async () => {
    const cookie = member(wrangler, "ec-resume");
    const file = mp4("resume.mp4", 43 * MIB);
    const first = engine(wrangler, cookie, (b, up) => {
      if (b.files[0] && b.files[0].loaded >= 2 * PART) up.dispose();
    });
    first.up.add([file]);
    await until("two parts stored", () => Number(rows(wrangler, "SELECT count(*) AS n FROM upload_part")[0]?.n) >= 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    first.up.dispose();
    const stored = Number(
      rows(
        wrangler,
        "SELECT count(*) AS n FROM upload_part WHERE upload_id = (SELECT id FROM upload WHERE user_id = 'ec-resume')",
      )[0]?.n,
    );
    expect(stored).toBeGreaterThanOrEqual(2);

    const second = engine(wrangler, cookie);
    await until("the paused row", () => second.snaps.some((b) => b.files.some((f) => f.state === "paused")));
    const paused = second.snaps.flatMap((b) => b.files).find((f) => f.state === "paused");
    await second.up.resume((paused as Snap).id, mp4("resume.mp4", 43 * MIB));
    await until("saved", () => second.snaps.at(-1)?.files[0]?.state === "saved", 60_000);
    const parts = Number(rows(wrangler, "SELECT parts FROM upload WHERE user_id = 'ec-resume'")[0]?.parts);
    expect(second.parts.length).toBe(parts - stored);
    expect(counters(wrangler, "ec-resume")).toEqual({ used: file.size, reserved: 0 });
  }, 120_000);

  it("cancel: DELETE closes the upload and returns the reservation", async () => {
    const cookie = member(wrangler, "ec-cancel");
    let canceled = false;
    const run = engine(wrangler, cookie, (b, up) => {
      const [f] = b.files;
      if (!canceled && f?.state === "uploading" && f.loaded > 0) {
        canceled = true;
        up.cancel(f.id);
      }
    });
    run.up.add([mp4("cancel.mp4", 43 * MIB)]);
    const last = await run.done;
    expect(last.files[0]).toMatchObject({ state: "canceled" });
    await until("the reservation returned", () => counters(wrangler, "ec-cancel")?.reserved === 0);
    expect(run.requests.some((r) => r.startsWith("DELETE /api/uploads/"))).toBe(true);
    expect(
      rows(wrangler, "SELECT count(*) AS n FROM upload WHERE user_id = 'ec-cancel' AND aborted_at IS NOT NULL")[0]?.n,
    ).toBe(1);
    expect(rows(wrangler, "SELECT count(*) AS n FROM library_file WHERE user_id = 'ec-cancel'")[0]?.n).toBe(0);
  }, 120_000);

  it("a refusal: the server's own reason, and the quota given back", async () => {
    const cookie = member(wrangler, "ec-refuse");
    const run = engine(wrangler, cookie);
    run.up.add([new File([new TextEncoder().encode("MZ not a deck at all")], "deck.pptx", { lastModified: STAMP })]);
    const last = await run.done;
    expect(last.files[0]).toMatchObject({ state: "refused", error: "bad_type" });
    expect(counters(wrangler, "ec-refuse")).toEqual({ used: 0, reserved: 0 });
    const torn = engine(wrangler, cookie);
    torn.up.add([new File([validDeck().slice(0, 120) as never], "torn.pptx", { lastModified: STAMP })]);
    expect((await torn.done).files[0]).toMatchObject({ state: "refused", error: "bad_structure" });
    expect(counters(wrangler, "ec-refuse")).toEqual({ used: 0, reserved: 0 });
  }, 60_000);

  it("a 507 quota_exceeded is that refusal at once: the create is asked once, never retried as a failing service", async () => {
    const cookie = member(wrangler, "ec-quota");
    wrangler.d1("UPDATE app_user SET quota_bytes = 10 WHERE id = 'ec-quota'");
    const run = engine(wrangler, cookie);
    run.up.add([mp4("big.mp4", 64)]);
    const last = await run.done;
    expect(last.files[0]).toMatchObject({ state: "refused", error: "quota_exceeded" });
    expect(run.requests.filter((r) => r === "POST /api/uploads")).toHaveLength(1);
    expect(run.parts).toEqual([]);
    expect(counters(wrangler, "ec-quota")).toEqual({ used: 0, reserved: 0 });
  }, 60_000);

  it("a 429 whose Retry-After is far off is the rate_limited refusal, and the batch goes on: no wait, no retry loop", async () => {
    // transitional: A limits option. The cap's day ends at UTC midnight and its Retry-After is the time left in it: in
    // the last 135 s that is a wait the engine would sit out, so the run starts just after midnight (a wait of at most
    // that long).
    const toMidnight = () => 86_400_000 - (Date.now() % 86_400_000);
    if (toMidnight() < 135_000) await new Promise((resolve) => setTimeout(resolve, toMidnight() + 1000));
    const cookie = member(limited, "ec-rate");
    const run = engine(limited, cookie);
    run.up.add([mp4("first.mp4", 64), mp4("second.mp4", 65)]);
    const last = await run.done;
    expect(last.files.map((f) => f.state)).toEqual(["saved", "refused"]);
    expect(last.files[1]).toMatchObject({ error: "rate_limited" });
    expect(run.requests.filter((r) => r === "POST /api/uploads")).toHaveLength(2);
  }, 240_000);

  it("a 409 library_full is that refusal, not a claim to wait out: the next file is not held up", async () => {
    const cookie = member(crowded, "ec-full");
    const run = engine(crowded, cookie);
    run.up.add([mp4("first.mp4", 64), mp4("second.mp4", 65)]);
    const last = await run.done;
    expect(last.files.map((f) => f.state)).toEqual(["saved", "refused"]);
    expect(last.files[1]).toMatchObject({ error: "library_full" });
    expect(run.requests.filter((r) => r === "POST /api/uploads")).toHaveLength(2);
    expect(counters(crowded, "ec-full")).toEqual({ used: expect.any(Number), reserved: 0 });
  }, 60_000);

  it("a complete the server cannot settle yet is repeated, not read: the file stays Checking and is never refused", async () => {
    const cookie = member(stuck, "ec-stuck");
    const run = engine(stuck, cookie);
    run.up.add([mp4("stuck.mp4", 17 * MIB)]);
    await until("a repeated complete", () => run.requests.filter((r) => r.endsWith("/complete")).length >= 2, 40_000);
    const state = run.snaps.at(-1)?.files[0]?.state;
    expect(state).toBe("checking");
    expect(run.requests.filter((r) => r.startsWith("GET /api/uploads/"))).toEqual([]);
    run.up.dispose();
  }, 60_000);
});

describe("a guest's file is never a library file", () => {
  it("UP-03 owner: a member's cookie on a guest drop writes nothing to that member's library or quota", async () => {
    const cookie = member(wrangler, "ec-guest");
    const api = new Api(wrangler.url);
    const { pid } = await pairPhone(api);
    const res = await sendDrop(api, pid, validDeck() as Uint8Array, {
      name: "Talk.pptx",
      headers: { Cookie: `__Host-bloop_sid=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(rows(wrangler, "SELECT count(*) AS n FROM upload WHERE user_id = 'ec-guest'")[0]?.n).toBe(0);
    expect(rows(wrangler, "SELECT count(*) AS n FROM library_file WHERE user_id = 'ec-guest'")[0]?.n).toBe(0);
    expect(counters(wrangler, "ec-guest")).toEqual({ used: 0, reserved: 0 });
  }, 60_000);
});
