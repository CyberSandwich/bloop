// The link preview route against `wrangler dev` (PREVIEW-01): GET /yt/<id>.jpg serves only the catalog's own video ids,
// each fetched from a local stand-in for i.ytimg.com (YT_THUMB_ORIGIN, test/yt-upstream.ts), never the real network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_VIDEO_ID } from "../../src/shared/demo-catalog.ts";
import { startUpstream, THUMB_FIXTURE, type Upstream, type UpstreamMode } from "../yt-upstream.ts";
import { inOneWindow } from "./open-client.ts";
import { Api, PEPPER } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

const PATH = `/yt/${DEMO_VIDEO_ID}.jpg`;
const UPSTREAM_PATH = `/vi/${DEMO_VIDEO_ID}/hqdefault.jpg`;
/// An id of the right shape that the catalog does not hold.
const OTHER = "ZZZZZZZZZZZ";

describe("PREVIEW-01 thumbnail route: allowlist, fixed upstream, validated answer, cache", () => {
  let wrangler: Wrangler;
  let upstream: Upstream;
  beforeAll(async () => {
    upstream = await startUpstream();
    wrangler = await startWrangler({ HASH_PEPPER: PEPPER, TEST_TIMING: "1", YT_THUMB_ORIGIN: upstream.origin });
  });
  afterAll(async () => {
    await wrangler?.stop();
    await upstream?.stop();
  });

  const get = (path: string, init?: RequestInit) => fetch(`${wrangler.url}${path}`, { redirect: "manual", ...init });
  const hits = () => upstream.hits.length;

  it("PREVIEW-01 failure: every bad upstream answer is a 404 that is never cached, with no detail", async () => {
    const modes: UpstreamMode[] = ["redirect", "status", "png", "html", "no-type", "bad-magic", "big"];
    for (const mode of modes) {
      upstream.mode = mode;
      const before = hits();
      const res = await get(PATH);
      expect(res.status, mode).toBe(404);
      expect(res.headers.get("Cache-Control"), mode).toBe("no-store");
      expect(res.headers.get("Content-Type"), mode).toBe("application/problem+json");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const body = await res.text();
      expect(JSON.parse(body), mode).toEqual({ type: "about:blank", status: 404, code: "not_found" });
      expect(body).not.toMatch(/ytimg|127\.0\.0\.1|evil|upstream/i);
      expect(hits() - before, mode).toBe(1);
    }
  });

  it("PREVIEW-01 failure: an upstream that never answers ends at the Worker's own timeout, as a 404", async () => {
    upstream.mode = "hang";
    const started = Date.now();
    const res = await get(PATH);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("PREVIEW-01 no-store failure: after failures the next good answer is served, so no failure was kept", async () => {
    upstream.mode = "ok";
    const res = await get(PATH);
    expect(res.status).toBe(200);
  });

  it("PREVIEW-01 image: a JPEG of the catalog's own id, with the cache and type headers and the usual policy", async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(Buffer.from(bytes).equals(THUMB_FIXTURE)).toBe(true);
  });

  it("PREVIEW-01 cache: a repeat is answered from the Worker's cache, with the same bytes and no upstream request", async () => {
    await get(PATH);
    const before = hits();
    for (let i = 0; i < 3; i++) {
      const res = await get(PATH);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
      expect(Buffer.from(await res.arrayBuffer()).equals(THUMB_FIXTURE)).toBe(true);
    }
    expect(hits()).toBe(before);
  });

  it("PREVIEW-01 upstream request: exactly one fixed path, and nothing of the client's request is forwarded", async () => {
    const fresh = await startUpstream();
    const other = await startWrangler({ HASH_PEPPER: PEPPER, TEST_TIMING: "1", YT_THUMB_ORIGIN: fresh.origin });
    try {
      const res = await fetch(`${other.url}${PATH}?cb=1&next=https://evil.example`, {
        headers: {
          Cookie: "__Host-bloop_sid=secret",
          Authorization: "Bearer secret",
          Referer: "https://elsewhere.example/page",
          Origin: "https://elsewhere.example",
          "X-Forwarded-For": "198.51.100.9",
          "CF-Connecting-IP": "198.51.100.9",
        },
      });
      expect(res.status).toBe(200);
      expect(fresh.hits).toHaveLength(1);
      const [hit] = fresh.hits;
      expect(hit?.url).toBe(UPSTREAM_PATH);
      const sent = JSON.stringify(hit?.headers).toLowerCase();
      for (const secret of ["secret", "evil", "elsewhere", "198.51.100.9"]) {
        expect(sent, secret).not.toContain(secret);
      }
      for (const name of ["cookie", "authorization", "referer", "origin", "x-forwarded-for", "cf-connecting-ip"]) {
        expect(hit?.headers[name], name).toBeUndefined();
      }
    } finally {
      await other.stop();
      await fresh.stop();
    }
  });

  it("PREVIEW-01 allowlist: an id the catalog does not hold is a 404 with no upstream request, whatever its shape", async () => {
    const before = hits();
    for (const path of [
      `/yt/${OTHER}.jpg`,
      "/yt/AAAAAAAAAAA.jpg",
      "/yt/short.jpg",
      `/yt/${DEMO_VIDEO_ID}x.jpg`,
      `/yt/${DEMO_VIDEO_ID}.png`,
      `/yt/${DEMO_VIDEO_ID}`,
      `/yt/${DEMO_VIDEO_ID}.jpg/`,
      `/yt/${DEMO_VIDEO_ID}.JPG`,
      `/yt/${DEMO_VIDEO_ID.toLowerCase()}.jpg`,
      "/yt/..%2F..%2Fapi%2Fhealth.jpg",
      `/yt/${OTHER.slice(0, 10)}%2F.jpg`,
      "/yt/http%3A%2F%2Fevil.example%2Fx.jpg",
      "/yt/",
      "/yt/.jpg",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expect(res.headers.get("Content-Type"), path).toBe("application/problem+json");
    }
    expect(hits()).toBe(before);
  });

  it("PREVIEW-01 methods: only GET reaches it; a write is 405 and fetches nothing", async () => {
    const before = hits();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get(PATH, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    }
    expect(hits()).toBe(before);
  });

  it("PREVIEW-01 link: the phone lists the video link with its preview path, and that path serves the picture", async () => {
    const api = new Api(wrangler.url);
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const code = (await api.get<{ code: { code: string } }>("/api/screen/state", created.body.sid)).body.code.code;
    const claimed = await api.post<{ pid: string }>("/api/claim", { code });
    const files = await api.get<{ items: { kind: string; preview?: string }[] }>("/api/files", claimed.body.pid);
    const previews = files.body.items.flatMap((i) => (i.preview ? [i.preview] : []));
    expect(previews).toEqual([PATH]);
    expect((await get(previews[0] as string)).status).toBe(200);
  });
});

describe("PREVIEW-01 rate limit: the route spends RL_FETCH per IP", () => {
  let wrangler: Wrangler;
  let upstream: Upstream;
  beforeAll(async () => {
    upstream = await startUpstream();
    // No TEST_TIMING: the platform binding is live, lowered so a few requests cross it.
    wrangler = await startWrangler(
      { HASH_PEPPER: PEPPER, YT_THUMB_ORIGIN: upstream.origin },
      { limits: { RL_FETCH: 3 } },
    );
  });
  afterAll(async () => {
    await wrangler?.stop();
    await upstream?.stop();
  });

  const from = (ip: string, path = PATH) => fetch(`${wrangler.url}${path}`, { headers: { "CF-Connecting-IP": ip } });

  it("PREVIEW-01 rate limit: the fourth request from one address is 429, another address is counted on its own", async () => {
    await inOneWindow();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await from("203.0.113.40")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await from("203.0.113.41")).status).toBe(200);
    // Unlisted ids spend it too, so a scan for ids is limited before it is answered.
    for (let i = 0; i < 3; i++) await from("203.0.113.42", `/yt/${OTHER}.jpg`);
    expect((await from("203.0.113.42", `/yt/${OTHER}.jpg`)).status).toBe(429);
    // The upstream saw the one picture once: the cache served the repeats.
    expect(upstream.hits).toHaveLength(1);
  });
});
