import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OPEN_MODES } from "../../src/shared/protocol.ts";
import { MAX_FRAME_BYTES, phoneFrame, screenFrame } from "../../src/worker/frames.ts";
import { bearer, checkWrite, fail, readJson } from "../../src/worker/http.ts";

const ORIGIN = "https://bloop.example";
const post = (headers: Record<string, string>, body = "{}") =>
  new Request(`${ORIGIN}/api/approve`, { method: "POST", headers, body });
const GOOD = { Origin: ORIGIN, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };

const code = async (r: Response | null) => (r ? ((await r.json()) as { code: string }).code : null);

describe("PAIR-06 csrf: checkWrite", () => {
  it("accepts a same-origin JSON post, with or without Sec-Fetch-Site", async () => {
    expect(checkWrite(post(GOOD), ORIGIN)).toBeNull();
    expect(checkWrite(post({ Origin: ORIGIN, "Content-Type": "application/json; charset=utf-8" }), ORIGIN)).toBeNull();
  });

  it("refuses a cross-origin or missing Origin", async () => {
    expect(await code(checkWrite(post({ ...GOOD, Origin: "https://evil.example" }), ORIGIN))).toBe("forbidden_origin");
    expect(await code(checkWrite(post({ ...GOOD, Origin: `${ORIGIN}.evil.example` }), ORIGIN))).toBe(
      "forbidden_origin",
    );
    expect(await code(checkWrite(post({ "Content-Type": "application/json" }), ORIGIN))).toBe("forbidden_origin");
    expect(await code(checkWrite(post({ ...GOOD, Origin: "null" }), ORIGIN))).toBe("forbidden_origin");
  });

  it("refuses a request the browser marks cross-site", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(await code(checkWrite(post({ ...GOOD, "Sec-Fetch-Site": site }), ORIGIN))).toBe("forbidden_origin");
    }
  });

  it("refuses a form post and a missing content type with 415", async () => {
    for (const type of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data",
      "application/jsonx",
      "",
    ]) {
      const headers: Record<string, string> = { Origin: ORIGIN };
      if (type) headers["Content-Type"] = type;
      const r = checkWrite(post(headers), ORIGIN);
      expect(r?.status, type).toBe(415);
    }
  });
});

describe("readJson", () => {
  const schema = z.object({ fileId: z.string().min(1) }).strict();
  const read = (body: string) => readJson(post(GOOD, body), schema);

  it("parses a valid body and treats an empty body as {}", async () => {
    expect(await read('{"fileId":"a"}')).toMatchObject({ ok: true, value: { fileId: "a" } });
    const empty = await readJson(post(GOOD, ""), z.object({}).strict());
    expect(empty.ok).toBe(true);
  });

  it("answers the body text it read, so a route hashing it never reads the body again", async () => {
    expect(await read('{"fileId":"a"}')).toEqual({ ok: true, value: { fileId: "a" }, text: '{"fileId":"a"}' });
  });

  it("PAIR-06 cap: a body over 4 KB is refused before parsing: a declared length unread, a stream once past the cap", async () => {
    const declared = post({ ...GOOD, "Content-Length": "5000" }, "x".repeat(5000));
    const refused = await readJson(declared, schema);
    expect(!refused.ok && refused.response.status).toBe(400);
    expect(declared.bodyUsed).toBe(false);
    // No length: chunks of 1 KB, pulled only until the cap is passed, then the stream is canceled.
    let pulls = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024).fill(0x20));
      },
      cancel() {
        canceled = true;
      },
    });
    const chunked = new Request(`${ORIGIN}/api/approve`, { method: "POST", headers: GOOD, body, duplex: "half" });
    const streamed = await readJson(chunked, schema);
    expect(!streamed.ok && streamed.response.status).toBe(400);
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(6);
    // Exactly at the cap is read; multi-byte text counts in bytes.
    const atCap = `{"fileId":"${"a".repeat(4096 - 13)}"}`;
    expect((await read(atCap)).ok).toBe(true);
    expect((await read(`{"fileId":"${"é".repeat(2100)}"}`)).ok).toBe(false);
  });

  it("refuses unknown keys, wrong types, bad JSON and oversized bodies with 400", async () => {
    for (const body of ['{"fileId":"a","x":1}', '{"fileId":1}', "{", "[]", `{"fileId":"${"a".repeat(5000)}"}`]) {
      const r = await read(body);
      expect(r.ok, body.slice(0, 20)).toBe(false);
      expect(!r.ok && r.response.status).toBe(400);
    }
  });
});

describe("http helpers", () => {
  it("fail() takes the status from the shared error table", async () => {
    const r = fail("code_expired");
    expect(r.status).toBe(410);
    expect(r.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await r.json()).toEqual({ type: "about:blank", status: 410, code: "code_expired" });
  });

  it("REL-03 retry: a 429 and a 503 carry Retry-After in whole seconds, a caller's figure rounded up", () => {
    expect(fail("rate_limited").headers.get("Retry-After")).toBe("10");
    expect(fail("rate_limited", undefined, 2.2).headers.get("Retry-After")).toBe("3");
    expect(fail("service_busy").status).toBe(503);
    expect(fail("service_busy", undefined, 30).headers.get("Retry-After")).toBe("30");
    expect(fail("service_busy", undefined, 0).headers.get("Retry-After")).toBe("1");
  });

  it("REL-03 retry: no other status carries Retry-After", () => {
    expect(fail("code_expired").headers.has("Retry-After")).toBe(false);
    expect(fail("internal").headers.has("Retry-After")).toBe(false);
  });

  it("bearer reads only a Bearer header", () => {
    const req = (auth?: string) => new Request(ORIGIN, auth ? { headers: { Authorization: auth } } : {});
    expect(bearer(req("Bearer abc"))).toBe("abc");
    expect(bearer(req("Basic abc"))).toBeNull();
    expect(bearer(req())).toBeNull();
  });
});

describe("frames", () => {
  it("accepts exactly the documented screen frames", () => {
    for (const f of [
      { v: 1, t: "hello", sid: "x" },
      { v: 1, t: "code.next" },
      { v: 1, t: "open.click" },
      { v: 1, t: "launched", mode: "download" },
      { v: 1, t: "ping" },
    ]) {
      expect(screenFrame.safeParse(f).success, f.t).toBe(true);
    }
  });

  it("the launched frame takes every open mode, from the one list the link route also builds from", () => {
    // A view launch (an image on a live screen) must not close the socket.
    for (const mode of OPEN_MODES) {
      expect(screenFrame.safeParse({ v: 1, t: "launched", mode }).success, mode).toBe(true);
    }
    expect(OPEN_MODES).toContain("view");
  });

  it("refuses unknown types, extra keys, wrong versions and bad modes", () => {
    for (const f of [
      { v: 1, t: "state" },
      { v: 2, t: "ping" },
      { v: 1, t: "ping", extra: 1 },
      { v: 1, t: "launched", mode: "rm -rf" },
      { v: 1, t: "hello" },
      { t: "ping" },
    ]) {
      expect(screenFrame.safeParse(f).success, JSON.stringify(f)).toBe(false);
    }
  });

  it("gives a phone only hello and ping", () => {
    expect(phoneFrame.safeParse({ v: 1, t: "hello", pid: "x" }).success).toBe(true);
    expect(phoneFrame.safeParse({ v: 1, t: "ping" }).success).toBe(true);
    expect(phoneFrame.safeParse({ v: 1, t: "code.next" }).success).toBe(false);
    expect(phoneFrame.safeParse({ v: 1, t: "open.click" }).success).toBe(false);
    expect(MAX_FRAME_BYTES).toBe(4096);
  });
});
