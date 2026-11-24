import { describe, expect, it } from "vitest";
import { policyOf, withHeaders } from "../../src/worker/headers.ts";
import type { Resolved } from "../../src/worker/seams/file-source/index.ts";
import { type LinkRecord, refusal } from "../../src/worker/seams/open-path/links.ts";
import { parseRange } from "../../src/worker/seams/open-path/range.ts";
import { openPathFor } from "../../src/worker/seams/open-path/select.ts";

const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);
const open = openPathFor("stream", []);

/** A guest video as the route resolves it: the size is known, and `body` honors a range. */
function video(type: "mp4" | "mov" = "mp4", size: number | null = BYTES.length): Resolved & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    name: "Clip.mp4",
    type,
    size,
    url: null,
    body: async (range) => {
      asked.push(range);
      const part = range ? BYTES.slice(range.offset, range.offset + range.length) : BYTES;
      return {
        ok: true,
        length: part.length,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(part);
            c.close();
          },
        }),
      };
    },
  };
}

const get = (range?: string, method = "GET") =>
  new Request("https://bloop.test/f/t/clip.mp4", { method, headers: range ? { Range: range } : {} });
const finished = (r: Response) => withHeaders(r, policyOf(r, "api"));

describe("VID-02 range parsing", () => {
  it("VID-02 reads one range: closed, open-ended, suffix, and clamped to the size", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-10", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-500", 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange("bytes=50-5000", 100)).toEqual({ offset: 50, length: 50 });
    expect(parseRange("bytes=99-99", 100)).toEqual({ offset: 99, length: 1 });
  });

  it("VID-02 refuses what is out of bounds, malformed or more than one range", () => {
    for (const bad of [
      "bytes=100-",
      "bytes=100-120",
      "bytes=9-3",
      "bytes=-0",
      "bytes=-",
      "bytes=0-9,20-29",
      "bytes=0-9, 20-",
      "items=0-9",
      "bytes=a-b",
      "bytes=99999999999999999999-",
      "",
    ]) {
      expect(parseRange(bad, 100), bad).toBe("unsatisfiable");
    }
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("VID-02 serving a range", () => {
  it("VID-02 answers a single range 206 with Content-Range, Content-Length and Accept-Ranges, reading only that range", async () => {
    const file = video();
    const res = finished(await open.serve(get("bytes=10-19"), file, "view"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(10, 20));
    expect(file.asked).toEqual([{ offset: 10, length: 10 }]);
  });

  it("VID-02 answers a request with no Range whole, and still offers ranges", async () => {
    const res = finished(await open.serve(get(), video(), "view"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(res.headers.get("Content-Range")).toBeNull();
  });

  it("VID-02 answers 416 with the size, and reads nothing, for an out-of-bounds, malformed or multiple range", async () => {
    for (const range of ["bytes=100-", "bytes=0-4,10-14", "bytes=zzz", "bytes=-0"]) {
      const file = video();
      const res = finished(await open.serve(get(range), file, "view"));
      expect(res.status, range).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */100");
      expect(file.asked).toEqual([]);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("VID-02 answers HEAD from the metadata with the length and no body, and ignores Range", async () => {
    const file = video();
    const res = finished(await open.serve(get("bytes=0-9", "HEAD"), file, "view"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await res.text()).toBe("");
    expect(file.asked).toEqual([]);
  });

  it("VID-02 answers every other type whole, whatever Range says", async () => {
    const pdf: Resolved = { ...video(), type: "pdf" };
    const res = finished(await open.serve(get("bytes=0-9"), pdf, "pdf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe("100");
  });

  it("VID-02 serves no ranges when the size is unknown", async () => {
    const res = finished(await open.serve(get("bytes=0-9"), video("mp4", null), "view"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBeNull();
  });
});

describe("VID-01 serving headers", () => {
  it("VID-01 serves mp4 and mov as video/mp4, nosniff, no-store, same-origin and sandboxed; inline to view, attachment to download", async () => {
    for (const type of ["mp4", "mov"] as const) {
      const view = finished(await open.serve(get(), video(type), "view"));
      expect(view.headers.get("Content-Type")).toBe("video/mp4");
      expect(view.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(view.headers.get("Cache-Control")).toBe("no-store");
      expect(view.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(view.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
      expect(view.headers.get("Content-Disposition")).toBe("inline");
      const download = finished(await open.serve(get(), video(type), "download"));
      expect(download.headers.get("Content-Type")).toBe("video/mp4");
      expect(download.headers.get("Content-Disposition")).toBe("attachment");
    }
  });
});

describe("VID-02 view links", () => {
  const limits = {
    firstFetchSeconds: 600,
    fetchWindowSeconds: 120,
    maxFetches: 10,
    maxMints: 5,
    binding: "log" as const,
  };
  const record = (purpose: "view" | "protocol", over: Partial<LinkRecord> = {}): LinkRecord => ({
    tokenHash: "h",
    purpose,
    item: 0,
    mintedAt: 0,
    firstFetchAt: 1000,
    fetches: 50,
    revoked: false,
    ...over,
  });

  it("VID-02 a view link outlives the fetch count and the short window, which a download keeps", () => {
    expect(refusal(record("protocol"), 2000, limits)).toBe("link_exhausted");
    expect(refusal(record("view"), 2000, limits)).toBeNull();
    expect(refusal(record("view"), 1000 + 10 * 60 * 1000, limits)).toBeNull();
    expect(refusal(record("protocol", { fetches: 1 }), 1000 + 130 * 1000, limits)).toBe("link_expired");
  });

  it("VID-02 a view link still ends: revoked, past its window, or never fetched in time", () => {
    expect(refusal(record("view", { revoked: true }), 2000, limits)).toBe("link_revoked");
    expect(refusal(record("view"), 1000 + 31 * 60 * 1000, limits)).toBe("link_expired");
    expect(refusal(record("view", { firstFetchAt: null }), 601 * 1000, limits)).toBe("link_expired");
  });
});
