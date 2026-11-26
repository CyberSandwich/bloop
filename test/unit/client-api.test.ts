import { describe, expect, it, vi } from "vitest";
import { createApi } from "../../public/js/core/api.js";
import { loadFiles } from "../../public/js/core/files.js";
import { createStore, dropPid, PID_KEY, pidStore, refOf, sameScreen } from "../../public/js/core/store.js";
import { FETCH_TIMEOUT_MS } from "../../public/js/core/timing.js";

interface Seen {
  path: string;
  init: RequestInit;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response> | Error) {
  const calls: Seen[] = [];
  const fetchFn = (async (path: string, init: RequestInit) => {
    const seen = { path, init };
    calls.push(seen);
    const out = await respond(seen);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "about:blank", status, code }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
// The marker the Worker puts on every ok answer (REL-03).
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "X-Bloop": "1" } });

describe("api client", () => {
  it("leave is a POST that outlives the page (keepalive); post is not", async () => {
    const f = fakeFetch(() => ok({}));
    const api = createApi({ fetch: f.fetch });
    await api.leave("/api/screen/end", "REF.SECRET");
    await api.post("/api/screen/end", {}, "REF.SECRET");
    expect(f.calls.map((c) => [c.init.method, c.init.keepalive])).toEqual([
      ["POST", true],
      ["POST", false],
    ]);
  });

  it("sends the credential as a Bearer header and never in the URL", async () => {
    const f = fakeFetch(() => ok({ state: "waiting" }));
    const api = createApi({ fetch: f.fetch });
    await api.get("/api/pair/state", "REF.SECRET");
    expect(f.calls[0]?.path).toBe("/api/pair/state");
    const init = f.calls[0]?.init as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer REF.SECRET");
  });

  it("every POST declares JSON and carries a body, even an empty one (CSRF check PAIR-06)", async () => {
    const f = fakeFetch(() => ok({}));
    const api = createApi({ fetch: f.fetch });
    await api.post("/api/cancel", undefined, "REF.SECRET");
    const init = f.calls[0]?.init as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe("{}");
    expect(init.method).toBe("POST");
  });

  it("does not set a body or content type on GET, and never caches", async () => {
    const f = fakeFetch(() => ok({}));
    await createApi({ fetch: f.fetch }).get("/api/files", "x.y");
    const init = f.calls[0]?.init as RequestInit;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
  });

  it("returns the parsed value", async () => {
    const f = fakeFetch(() => ok({ pid: "a.b" }));
    expect(await createApi({ fetch: f.fetch }).post("/api/claim", { code: "K7MQ9X" })).toMatchObject({
      ok: true,
      value: { pid: "a.b" },
    });
  });

  it("maps a problem response to its error code", async () => {
    const f = fakeFetch(() => problem(410, "code_expired"));
    expect(await createApi({ fetch: f.fetch }).post("/api/claim", { code: "K7MQ9X" })).toEqual({
      ok: false,
      error: "code_expired",
    });
  });

  it("an unknown code in a problem body is not trusted as the page's, only carried as `code` for a lazy module", async () => {
    const f = fakeFetch(() => problem(400, "made_up"));
    expect(await createApi({ fetch: f.fetch }).get("/x")).toEqual({ code: "made_up", ok: false, error: "bad_request" });
  });

  it("a network failure is offline", async () => {
    const f = fakeFetch(() => new TypeError("Failed to fetch"));
    expect(await createApi({ fetch: f.fetch }).get("/x")).toEqual({ ok: false, error: "offline" });
  });

  it("a request with no answer in FETCH_TIMEOUT_MS is aborted and ends as offline", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch(
        ({ init }) =>
          new Promise<Response>((_, fail) => init.signal?.addEventListener("abort", () => fail(init.signal?.reason))),
      );
      const pending = createApi({ fetch: f.fetch }).get("/api/screens");
      const signal = f.calls[0]?.init.signal;
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual({ ok: false, error: "offline" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a call that has answered, or failed, leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const answered = fakeFetch(() => ok({}));
      await createApi({ fetch: answered.fetch }).get("/api/files", "p.q");
      const failed = fakeFetch(() => new TypeError("Failed to fetch"));
      await createApi({ fetch: failed.fetch }).get("/api/files", "p.q");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only reads and the boot are timed: a slow write (an approve) may still land", async () => {
    const f = fakeFetch(() => ok({}));
    const api = createApi({ fetch: f.fetch });
    await api.post("/api/approve", { ids: [] }, "p.q");
    await api.leave("/api/screen/end", "s.t");
    await api.call("POST", "/api/screens", { body: { mode: "demo" }, timeout: true });
    await api.get("/api/files", "p.q");
    expect(f.calls.map((c) => [c.path, c.init.signal instanceof AbortSignal])).toEqual([
      ["/api/approve", false],
      ["/api/screen/end", false],
      ["/api/screens", true],
      ["/api/files", true],
    ]);
  });

  it("a browser without AbortSignal.timeout (Safari 15.4) times a read out with an AbortController", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Reflect.deleteProperty(AbortSignal, "timeout");
    vi.useFakeTimers();
    try {
      const f = fakeFetch(
        ({ init }) =>
          new Promise<Response>((_, fail) => init.signal?.addEventListener("abort", () => fail(init.signal?.reason))),
      );
      const pending = createApi({ fetch: f.fetch }).get("/api/screen/state", "s.t");
      const signal = f.calls[0]?.init.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual({ ok: false, error: "offline" });
      // A write is untimed, as with the native signal.
      const write = fakeFetch(() => ok({}));
      await createApi({ fetch: write.fetch }).post("/api/approve", {}, "p.q");
      expect(write.calls[0]?.init.signal).toBeUndefined();
    } finally {
      vi.useRealTimers();
      if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout);
    }
  });

  it("a 5xx without a problem body is service_down", async () => {
    const down = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await createApi({ fetch: down.fetch }).get("/x")).toEqual({ ok: false, error: "service_down" });
  });

  it("O19 a 429 carries Retry-After in seconds; no header, a date or a non-429 carries none", async () => {
    const limited = (headers: Record<string, string>, status = 429) =>
      fakeFetch(() => new Response(JSON.stringify({ code: "rate_limited" }), { status, headers }));
    expect(await createApi({ fetch: limited({ "Retry-After": "30" }).fetch }).get("/x")).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfter: 30,
    });
    for (const h of [{}, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, { "Retry-After": "0" }]) {
      expect(await createApi({ fetch: limited(h).fetch }).get("/x")).toEqual({ ok: false, error: "rate_limited" });
    }
    expect(await createApi({ fetch: limited({ "Retry-After": "30" }, 400).fetch }).get("/x")).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  it("REL-03 a 200 block page reads as network_blocked, not service_down: HTML, or JSON without the marker", async () => {
    const page = fakeFetch(() => new Response("<html>Blocked by your network</html>", { status: 200 }));
    expect(await createApi({ fetch: page.fetch }).get("/x")).toEqual({ ok: false, error: "network_blocked" });
    const bare = fakeFetch(() => new Response("{}", { status: 200 }));
    expect(await createApi({ fetch: bare.fetch }).get("/x")).toEqual({ ok: false, error: "network_blocked" });
    const empty = fakeFetch(() => new Response("", { status: 200, headers: { "X-Bloop": "1" } }));
    expect(await createApi({ fetch: empty.fetch }).get("/x")).toEqual({
      ok: true,
      value: {},
      headers: expect.anything(),
    });
  });
});

describe("file list", () => {
  it("returns every item the route sends, files then links, in its order", async () => {
    const file = { kind: "file", id: "a", name: "A.pptx", type: "pptx", modifiedAt: 1, size: null };
    const link = { kind: "link", id: "l", url: "https://www.vevox.com/", title: "Vevox" };
    const f = fakeFetch(() => ok({ items: [file, link] }));
    expect(await loadFiles(createApi({ fetch: f.fetch }), "p.q")).toEqual({ ok: true, files: [file, link] });
  });

  it("treats a body without a list as an empty list", async () => {
    const f = fakeFetch(() => ok({}));
    expect(await loadFiles(createApi({ fetch: f.fetch }), "p.q")).toEqual({ ok: true, files: [] });
  });

  it("has no stub fallback: a missing route is an error", async () => {
    const f = fakeFetch(() => problem(404, "not_found"));
    expect(await loadFiles(createApi({ fetch: f.fetch }), "p.q")).toEqual({ ok: false, error: "not_found" });
  });

  it("passes every other failure through", async () => {
    const f = fakeFetch(() => problem(401, "auth_required"));
    expect(await loadFiles(createApi({ fetch: f.fetch }), "p.q")).toEqual({ ok: false, error: "auth_required" });
  });
});

describe("credentials", () => {
  it("refOf is the screen ref both a sid and a pid start with", () => {
    expect(refOf("ref1.secret")).toBe("ref1");
    expect(refOf("ref1")).toBe("ref1");
  });

  it("DEMO-01 round trip: a pid pairs with this tab's screen only when both name the same screen", () => {
    expect(sameScreen("ref1.sidsecret", "ref1.pidsecret")).toBe(true);
    // A sid left from another screen (a typed code from elsewhere, an old demo) is not this claim's screen.
    expect(sameScreen("ref0.sidsecret", "ref1.pidsecret")).toBe(false);
    expect(sameScreen(null, "ref1.pidsecret")).toBe(false);
    expect(sameScreen("ref1.sidsecret", null)).toBe(false);
  });
});

describe("session store", () => {
  it("reads and writes through the storage area", () => {
    const area = new Map<string, string>();
    const store = createStore({
      getItem: (k) => area.get(k) ?? null,
      setItem: (k, v) => void area.set(k, v),
      removeItem: (k) => void area.delete(k),
    });
    store.set("bloop.pid", "a.b");
    expect(area.get("bloop.pid")).toBe("a.b");
    expect(store.get("bloop.pid")).toBe("a.b");
    store.remove("bloop.pid");
    expect(store.get("bloop.pid")).toBeNull();
  });

  it("falls back to memory when storage throws, and never throws itself", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    const store = createStore({ getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => store.set("k", "v")).not.toThrow();
    expect(store.get("k")).toBe("v");
    expect(() => store.remove("k")).not.toThrow();
    expect(store.get("k")).toBeNull();
  });

  it("works with no storage at all", () => {
    const store = createStore(null);
    store.set("k", "v");
    expect(store.get("k")).toBe("v");
  });

  it("PAIR-12 pid-store: a tab drops the pid only when it is its own, so another tab's newer pairing stays", () => {
    const store = createStore(null);
    store.set(PID_KEY, "ref-b.secret");
    dropPid(store, "ref-a.secret");
    expect(store.get(PID_KEY)).toBe("ref-b.secret");
    dropPid(store, null);
    expect(store.get(PID_KEY)).toBe("ref-b.secret");
    dropPid(store, "ref-b.secret");
    expect(store.get(PID_KEY)).toBeNull();
  });

  it("PAIR-12 pid-store: the pid lives in localStorage, so a later page reads it, until it is removed by name", () => {
    const area = new Map<string, string>();
    const local = {
      getItem: (k: string) => area.get(k) ?? null,
      setItem: (k: string, v: string) => void area.set(k, v),
      removeItem: (k: string) => void area.delete(k),
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    try {
      pidStore().set(PID_KEY, "ref.secret");
      // A new page (a fresh store over the same area) still holds it: a closed tab can come back to Revoke.
      expect(pidStore().get(PID_KEY)).toBe("ref.secret");
      pidStore().remove(PID_KEY);
      expect(area.has(PID_KEY)).toBe(false);
      expect(pidStore().get(PID_KEY)).toBeNull();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
