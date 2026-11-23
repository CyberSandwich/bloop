import { describe, expect, it } from "vitest";
import { createApi } from "../../public/js/core/api.js";
import { loadFiles, stubFiles } from "../../public/js/core/files.js";
import { createStore } from "../../public/js/core/store.js";

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
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("api client", () => {
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

  it("an unknown code in a problem body is not trusted", async () => {
    const f = fakeFetch(() => problem(400, "made_up"));
    expect(await createApi({ fetch: f.fetch }).get("/x")).toEqual({ ok: false, error: "bad_request" });
  });

  it("a network failure is offline", async () => {
    const f = fakeFetch(() => new TypeError("Failed to fetch"));
    expect(await createApi({ fetch: f.fetch }).get("/x")).toEqual({ ok: false, error: "offline" });
  });

  it("a 5xx without a problem body, or a 200 that is not JSON, is service_down", async () => {
    const down = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await createApi({ fetch: down.fetch }).get("/x")).toEqual({ ok: false, error: "service_down" });
    const junk = fakeFetch(() => new Response("<html>", { status: 200 }));
    expect(await createApi({ fetch: junk.fetch }).get("/x")).toEqual({ ok: false, error: "service_down" });
  });
});

describe("file list", () => {
  it("returns the files the route sends", async () => {
    const files = [{ id: "a", name: "A.pptx", type: "pptx", modifiedAt: 1, size: null }];
    const f = fakeFetch(() => ok({ files }));
    expect(await loadFiles(createApi({ fetch: f.fetch }), "p.q")).toEqual({ ok: true, files });
  });

  it("falls back to the two stub fixtures only while the route does not exist", async () => {
    const f = fakeFetch(() => problem(404, "not_found"));
    const got = await loadFiles(createApi({ fetch: f.fetch }), "p.q", () => 1_000_000);
    expect(got).toEqual({ ok: true, files: stubFiles(1_000_000) });
    expect(stubFiles(0).map((x) => x.id)).toEqual(["demo-deck", "demo-pdf"]);
  });

  it("passes every other failure through", async () => {
    const f = fakeFetch(() => problem(401, "auth_required"));
    expect(await loadFiles(createApi({ fetch: f.fetch }), "p.q")).toEqual({ ok: false, error: "auth_required" });
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
});
