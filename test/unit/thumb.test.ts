// PREVIEW-01: a link item's preview is a same-origin thumbnail path, served by the one upstream fetch in yt-thumb.ts.
import { describe, expect, it } from "vitest";
import { DEMO_ITEMS, DEMO_VIDEO_ID } from "../../src/shared/demo-catalog.ts";
import { allowedLink, allowedPreview, itemView, LINK_HOSTS, listedLink } from "../../src/worker/items.ts";
import { transition } from "../../src/worker/machine.ts";
import { phoneView, screenView } from "../../src/worker/views.ts";
import {
  fetchThumb,
  MAX_THUMB_BYTES,
  PREVIEW_PATH,
  previewId,
  previewPath,
  THUMB_ORIGIN,
  throughCache,
  upstreamUrl,
} from "../../src/worker/yt-thumb.ts";
import { asItem, CFG, claimedOwner, DECK, MAX_MINUTES, sec, T0, VEVOX } from "./machine-helpers.ts";

const ID = "AbC_-123456";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

type Init = RequestInit & { signal?: AbortSignal };
interface Call {
  url: string;
  init: Init;
}

/** A fake fetch that records its calls and answers `make`'s response. */
function fake(make: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = ((input: string, init: Init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(make(call));
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const jpeg = (
  body: ConstructorParameters<typeof Response>[0] = JPEG,
  headers: Record<string, string> = {},
  status = 200,
) => new Response(body, { status, headers: { "Content-Type": "image/jpeg", ...headers } });

describe("PREVIEW-01 preview path: one strict same-origin shape", () => {
  it("accepts /yt/<11 id chars>.jpg and answers the id", () => {
    expect(previewId(`/yt/${ID}.jpg`)).toBe(ID);
    expect(previewPath(ID)).toBe(`/yt/${ID}.jpg`);
    expect(previewId(previewPath(ID))).toBe(ID);
    expect(allowedPreview(`/yt/${ID}.jpg`)).toBe(`/yt/${ID}.jpg`);
  });

  it("refuses an absolute or third-party URL, another path, another id length and anything around the shape", () => {
    for (const bad of [
      `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
      `https://bloop.example/yt/${ID}.jpg`,
      `//evil.example/yt/${ID}.jpg`,
      `http://localhost/yt/${ID}.jpg`,
      `javascript:alert(1)`,
      `data:image/jpeg;base64,AAAA`,
      `yt/${ID}.jpg`,
      `/yt/${ID}.png`,
      `/yt/${ID}.jpg?x=1`,
      `/yt/${ID}.jpg#x`,
      `/yt/${ID}.jpg\n`,
      `/yt/${ID}.jpg/`,
      ` /yt/${ID}.jpg`,
      `/yt/../${ID}.jpg`,
      `/yt/${ID.slice(1)}.jpg`,
      `/yt/${ID}x.jpg`,
      `/yt/${ID.slice(0, 10)}.jpg`,
      `/yt/${ID.slice(0, 10)}%2F.jpg`,
      `/yt/${ID.slice(0, 10)}/.jpg`,
      `/yt/${ID.slice(0, 10)}\\.jpg`,
      `/img/${ID}.jpg`,
      `/api/${ID}.jpg`,
      "",
    ]) {
      expect(allowedPreview(bad), bad).toBeNull();
      expect(previewId(bad), bad).toBeNull();
    }
    expect(PREVIEW_PATH.source).toContain("[A-Za-z0-9_-]{11}");
  });
});

describe("PREVIEW-01 upstream URL: built from the id alone, on the one host", () => {
  it("is https on i.ytimg.com with the id in the path and nothing else", () => {
    const url = new URL(upstreamUrl(ID) as string);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("i.ytimg.com");
    expect(url.username + url.password + url.port + url.search + url.hash).toBe("");
    expect(url.pathname).toBe(`/vi/${ID}/hqdefault.jpg`);
    expect(THUMB_ORIGIN).toBe("https://i.ytimg.com");
  });

  it("is null for any string that is not an id: nothing can steer the host, the path or the query", () => {
    for (const bad of [
      "",
      "short",
      `${ID}x`,
      "a/../b?x=#yyyy",
      "AAAAAAAAAAA/../../",
      "AAAAAAAAAAA?x=1",
      "AAAAAAAAAA@",
      "evil.example/",
      "AAAAAAAAAA\n",
      "AAAAAAAAAA%2F",
    ]) {
      expect(upstreamUrl(bad), bad).toBeNull();
    }
  });
});

describe("PREVIEW-01 fetch: a fixed minimal request, a validated answer", () => {
  it("returns the bytes of a good JPEG", async () => {
    const { fetcher, calls } = fake(() => jpeg());
    const got = await fetchThumb(ID, fetcher);
    expect(got).toEqual({ ok: true, bytes: JPEG });
    expect(calls).toHaveLength(1);
  });

  it("sends one GET to the exact upstream URL with redirects off, no cookie and no referrer, and a timeout", async () => {
    const { fetcher, calls } = fake(() => jpeg());
    await fetchThumb(ID, fetcher);
    const [call] = calls;
    expect(call?.url).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    expect(call?.init.method).toBe("GET");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.body).toBeUndefined();
    const names = Object.keys((call?.init.headers ?? {}) as Record<string, string>).map((n) => n.toLowerCase());
    expect(names.sort()).toEqual(["accept", "user-agent"]);
    expect(call?.init.credentials).toBeUndefined();
  });

  it("makes no request at all for a string that is not an id", async () => {
    const { fetcher, calls } = fake(() => jpeg());
    for (const bad of ["", "x", "../../etc/passwd", `${ID}/x`, "AAAAAAAAAAA?x=1"]) {
      expect(await fetchThumb(bad, fetcher)).toEqual({ ok: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("uses the origin it is given (the test stand-in) with the same path", async () => {
    const { fetcher, calls } = fake(() => jpeg());
    await fetchThumb(ID, fetcher, "http://127.0.0.1:9");
    expect(calls[0]?.url).toBe(`http://127.0.0.1:9/vi/${ID}/hqdefault.jpg`);
  });

  it("refuses a redirect and every status but 200, and reads nothing from them", async () => {
    for (const status of [301, 302, 303, 307, 308, 204, 206, 304, 400, 403, 404, 429, 500, 503]) {
      const { fetcher } = fake(() => jpeg(JPEG, { Location: "https://evil.example/x.jpg" }, status));
      expect(await fetchThumb(ID, fetcher), String(status)).toEqual({ ok: false });
    }
    const opaque = fake(() => {
      const res = jpeg();
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      Object.defineProperty(res, "status", { value: 0 });
      return res;
    });
    expect(await fetchThumb(ID, opaque.fetcher)).toEqual({ ok: false });
  });

  it("refuses a network error, a rejection and a synchronous throw", async () => {
    const rejects = (() => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;
    expect(await fetchThumb(ID, rejects)).toEqual({ ok: false });
    const throws = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await fetchThumb(ID, throws)).toEqual({ ok: false });
  });

  it("gives up at the timeout when the upstream never answers", async () => {
    const hangs = ((_: string, init: Init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      })) as unknown as typeof fetch;
    expect(await fetchThumb(ID, hangs, THUMB_ORIGIN, 20)).toEqual({ ok: false });
  });

  it("gives up when the body stalls after the headers", async () => {
    const stalls = ((_: string, init: Init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(JPEG);
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "TimeoutError")));
        },
      });
      return Promise.resolve(jpeg(body));
    }) as unknown as typeof fetch;
    expect(await fetchThumb(ID, stalls, THUMB_ORIGIN, 20)).toEqual({ ok: false });
  });

  it("takes image/jpeg only, whatever its case or parameters, and nothing else or nothing", async () => {
    for (const type of ["image/jpeg; charset=binary", "IMAGE/JPEG", " image/jpeg "]) {
      const { fetcher } = fake(() => jpeg(JPEG, { "Content-Type": type }));
      expect((await fetchThumb(ID, fetcher)).ok, type).toBe(true);
    }
    for (const type of [
      "image/png",
      "image/webp",
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
      "image/jpegx",
    ]) {
      const { fetcher } = fake(() => jpeg(JPEG, { "Content-Type": type }));
      expect((await fetchThumb(ID, fetcher)).ok, type).toBe(false);
    }
    const bare = new Response(JPEG);
    bare.headers.delete("Content-Type");
    expect(await fetchThumb(ID, (() => Promise.resolve(bare)) as unknown as typeof fetch)).toEqual({ ok: false });
  });

  it("checks the bytes start with the JPEG magic FF D8 FF, whatever the header says", async () => {
    const bodies: Uint8Array[] = [
      new TextEncoder().encode("<html>not a picture</html>"),
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      Uint8Array.from([0xff, 0xd8, 0x00, 0xe0]),
      Uint8Array.from([0xff, 0xd8]),
      Uint8Array.from([0xff]),
      new Uint8Array(0),
    ];
    for (const body of bodies) {
      const { fetcher } = fake(() => jpeg(body));
      expect((await fetchThumb(ID, fetcher)).ok).toBe(false);
    }
    const { fetcher } = fake(() => jpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])));
    expect((await fetchThumb(ID, fetcher)).ok).toBe(true);
  });

  it("caps the size: a declared length over it is refused unread, a longer stream is cancelled at the cap", async () => {
    const declared = fake(() => jpeg(JPEG, { "Content-Length": String(MAX_THUMB_BYTES + 1) }));
    expect(await fetchThumb(ID, declared.fetcher)).toEqual({ ok: false });

    let cancelled = false;
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        const chunk = new Uint8Array(50_000);
        chunk.set(JPEG);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    // No Content-Length: the stream itself is the only thing that can show its size.
    const { fetcher } = fake(() => new Response(endless, { headers: { "Content-Type": "image/jpeg" } }));
    expect(await fetchThumb(ID, fetcher)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_THUMB_BYTES / 50_000) + 2);
  });

  it("takes a picture of exactly the cap and refuses one byte more", async () => {
    const at = new Uint8Array(MAX_THUMB_BYTES);
    at.set(JPEG);
    const over = new Uint8Array(MAX_THUMB_BYTES + 1);
    over.set(JPEG);
    expect((await fetchThumb(ID, fake(() => jpeg(at)).fetcher)).ok).toBe(true);
    expect((await fetchThumb(ID, fake(() => jpeg(over)).fetcher)).ok).toBe(false);
  });

  it("refuses a stream that errors midway, and says nothing of why", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(JPEG);
        controller.error(new Error("secret upstream detail"));
      },
    });
    const got = await fetchThumb(ID, fake(() => jpeg(broken)).fetcher);
    expect(got).toEqual({ ok: false });
    expect(JSON.stringify(got)).not.toContain("secret");
  });
});

describe("PREVIEW-01 link items carry the preview through the views", () => {
  const preview = previewPath(ID);

  it("allows the video host as a link and keeps the preview apart from the checked URL", () => {
    expect(LINK_HOSTS).toContain("www.youtube.com");
    const watch = `https://www.youtube.com/watch?v=${ID}`;
    expect(allowedLink(watch)).toBe(watch);
    // Look-alikes of the new host and its sibling hosts stay refused.
    for (const bad of [
      "https://youtube.com/",
      "https://m.youtube.com/",
      "https://youtu.be/x",
      "https://www.youtube.com.evil.example/",
      "https://www.youtube-nocookie.com/",
      "https://www.youtube.com:8443/",
    ]) {
      expect(allowedLink(bad), bad).toBeNull();
    }
  });

  it("itemView adds a link's preview only when it has one, and never a file's", () => {
    expect(itemView({ ...VEVOX, id: "i1" })).toEqual({ kind: "link", id: "i1", url: VEVOX.url, title: VEVOX.title });
    expect(itemView({ ...VEVOX, id: "i1", preview })).toEqual({
      kind: "link",
      id: "i1",
      url: VEVOX.url,
      title: VEVOX.title,
      preview,
    });
  });

  it("the screen view and the phone view carry the preview and nothing else new about the item", () => {
    const step = transition(
      claimedOwner(),
      { e: "approve", now: T0 + sec(5), items: [asItem(DECK), { ...VEVOX, preview }], minutes: MAX_MINUTES },
      CFG,
    );
    if (!step.ok) throw new Error(step.error);
    const meta = {
      screenRef: "r",
      mode: "demo" as const,
      roomId: null,
      roomName: null,
      screenSecretHash: "h",
      createdAt: T0,
      linkOrigin: "file" as const,
    };
    const screen = screenView(
      meta,
      step.next,
      { origin: "https://bloop.test", machine: CFG, library: { largeFileChoiceBytes: 1 } },
      T0 + sec(6),
    );
    const phone = phoneView(meta, step.next, T0 + sec(6), { dropMaxBytes: 1, maxMinutes: 1 });
    const want = { kind: "link", id: "i2", url: VEVOX.url, title: VEVOX.title, preview };
    expect(screen.items[1]).toEqual(want);
    expect(phone?.items[1]).toEqual(want);
    // The view's own keys are unchanged: the preview rides inside an item, no flag beside it.
    expect(Object.keys(screen).some((k) => /preview|thumb/i.test(k))).toBe(false);
    expect(JSON.stringify(screen)).not.toContain(DEMO_ITEMS.link.id);
    expect(JSON.stringify(screen).match(/yt\//g)).toHaveLength(1);
  });
});

describe("PREVIEW-01 itemView re-checks a stored preview", () => {
  it("drops a preview that is not a same-origin /yt/ path, whatever was stored", () => {
    for (const bad of [
      "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg",
      "//evil.example/yt/aaaaaaaaaaa.jpg",
      "/yt/short.jpg",
    ]) {
      expect(itemView({ ...VEVOX, id: "i1", preview: bad })).toEqual({
        kind: "link",
        id: "i1",
        url: VEVOX.url,
        title: VEVOX.title,
      });
    }
  });
});

describe("PREVIEW-01 the cache never turns an answer into a 500", () => {
  const key = new Request("https://bloop.test/yt/aaaaaaaaaaa.jpg");
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1]);
  const deferred: Promise<unknown>[] = [];
  const defer = (work: Promise<unknown>) => deferred.push(work);
  const keep = (b: Uint8Array | ArrayBuffer) => new Response(b as ArrayBuffer);

  it("a cache that throws on match is a miss: the picture is loaded fresh", async () => {
    const cache = {
      match: () => Promise.reject(new Error("cache down")),
      put: () => Promise.resolve(),
    };
    expect(await throughCache(cache, key, async () => bytes, keep, defer)).toBe(bytes);
  });

  it("a cache that throws on put still answers, and the failed put is not an unhandled rejection", async () => {
    const cache = {
      match: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error("quota")),
    };
    expect(await throughCache(cache, key, async () => bytes, keep, defer)).toBe(bytes);
    await expect(Promise.all(deferred)).resolves.toBeDefined();
  });

  it("a hit is served without loading, and a failed load is null (the route's 404)", async () => {
    let loads = 0;
    const hit = {
      match: () => Promise.resolve(new Response(bytes)),
      put: () => Promise.resolve(),
    };
    const got = await throughCache(hit, key, async () => (loads++, bytes), keep, defer);
    expect(new Uint8Array(got as ArrayBuffer)).toEqual(bytes);
    expect(loads).toBe(0);
    const miss = { match: () => Promise.resolve(undefined), put: () => Promise.resolve() };
    expect(await throughCache(miss, key, async () => null, keep, defer)).toBeNull();
  });
});

describe("PREVIEW-01 the phone's list drops a link whose preview is not a same-origin thumbnail", () => {
  const good = `/yt/${DEMO_VIDEO_ID}.jpg`;

  it("keeps a link with no preview or a same-origin one, with the URL as normalized", () => {
    expect(listedLink({ ...VEVOX })).toEqual({ ...VEVOX, url: allowedLink(VEVOX.url) });
    expect(listedLink({ ...VEVOX, preview: good })?.preview).toBe(good);
  });

  it("lists nothing for an absolute, protocol-relative or malformed preview, or a refused URL", () => {
    for (const preview of [
      "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      "//evil.example/yt/aaaaaaaaaaa.jpg",
      "/yt/x.jpg",
      "",
    ]) {
      expect(listedLink({ ...VEVOX, preview }), preview).toBeNull();
    }
    expect(listedLink({ ...VEVOX, url: "http://not-allowed.example/" })).toBeNull();
  });
});
