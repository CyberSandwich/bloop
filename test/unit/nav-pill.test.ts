// The open site's account pill (src/worker/nav-pill.ts): the Worker shows Library to a visitor holding the hint
// cookie. The cache rules matter more than the swap: a copy kept by the browser must never show the other label.
import { describe, expect, it } from "vitest";
import { ACCOUNT_PILL_OUT as PILL_OUT } from "../../src/shared/account-pill.ts";
import { HINT_COOKIE, pillRequest, withAccountPill } from "../../src/worker/nav-pill.ts";
import { type PageEnv, servePage } from "../../src/worker/pages.ts";
import { PROD_VARS } from "../env-vars.ts";
import { testDb } from "./d1-shim.ts";

const ORIGIN = "http://localhost:8787";
const BODY = `<nav>${PILL_OUT}</nav>`;
const request = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/privacy`, { headers });
const IN = { Cookie: `${HINT_COOKIE}=1` };
const label = (html: string) => (html.includes(">Library</a>") ? "Library" : "Sign In");

/** An asset layer with real ETag behavior: one body and one ETag per path, a 304 when the validator matches. */
function world(mode: "preview" | "open") {
  const db = testDb();
  db.raw
    .prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)")
    .run("launch_mode", mode, 1);
  const seen: Request[] = [];
  const env = {
    ...PROD_VARS,
    PUBLIC_ORIGIN: ORIGIN,
    TEST_TIMING: "1",
    DB: db,
    ASSETS: {
      fetch: async (req: Request) => {
        seen.push(req);
        const path = new URL(req.url).pathname;
        if (path === "/.missing" || path === "/nope") return new Response("not found", { status: 404 });
        const etag = `"v${path.replace(/\W/g, "")}"`;
        const headers = { "Content-Type": "text/html", ETag: etag, "Cache-Control": "no-cache" };
        const match = (req.headers.get("If-None-Match") ?? "").split(",").map((t) => t.trim());
        if (match.includes(etag)) return new Response(null, { status: 304, headers });
        return new Response(path === "/open/404" ? `404 ${BODY}` : BODY, { status: 200, headers });
      },
    },
  } as unknown as PageEnv;
  return { env, seen };
}
const get = (env: PageEnv, headers: Record<string, string> = {}, path = "/privacy") =>
  servePage(new Request(`${ORIGIN}${path}`, { headers }), env);

describe("pill rewrites href and label only for __Host-bloop_in=1", () => {
  it.each([
    ["no cookie", {}, "Sign In"],
    ["the hint set", IN, "Library"],
    ["the hint at another value", { Cookie: `${HINT_COOKIE}=0` }, "Sign In"],
    ["the same name without the host prefix", { Cookie: "bloop_in=1" }, "Sign In"],
    ["other cookies around it", { Cookie: `a=b; ${HINT_COOKIE}=1; c=d` }, "Library"],
  ])("%s shows %s", async (_name, headers, shown) => {
    const res = await withAccountPill(
      request(headers),
      new Response(BODY, { headers: { "Content-Type": "text/html" } }),
    );
    const html = await res.text();
    expect(label(html)).toBe(shown);
    if (shown === "Library") {
      expect(html).toContain('<a class="btn account" href="/library" data-account>Library</a>');
      expect(html).not.toContain("Sign In");
    } else {
      expect(html).toBe(BODY);
    }
  });

  it("leaves a response that is not HTML alone", async () => {
    const res = await withAccountPill(request(IN), new Response(BODY, { headers: { "Content-Type": "text/xml" } }));
    expect(res.headers.get("Vary")).toBeNull();
    expect(await res.text()).toBe(BODY);
  });

  it("a page without the pill is served as written", async () => {
    const res = await withAccountPill(
      request(IN),
      new Response("<p>x</p>", { headers: { "Content-Type": "text/html" } }),
    );
    expect(await res.text()).toBe("<p>x</p>");
  });
});

describe("pill 304 never serves the other label: the validator follows the copy", () => {
  it.each([
    ["names the signed-in copy", '"v1-in"', '"v1"'],
    ["names a list holding it", '"a", "v1-in"', '"v1"'],
    ["is weak", 'W/"v1-in"', 'W/"v1"'],
    ["names the signed-out copy", '"v1"', null],
    ["is a wildcard", "*", null],
  ])("a signed-in request whose If-None-Match %s reaches the asset layer as %s", (_name, sent, forwarded) => {
    const out = pillRequest(request({ ...IN, "If-None-Match": sent }));
    expect(out.headers.get("If-None-Match")).toBe(forwarded);
  });

  it("a signed-in request drops If-Modified-Since, and a signed-out one is forwarded untouched", () => {
    expect(
      pillRequest(request({ ...IN, "If-Modified-Since": "Mon, 01 Jan 2026 00:00:00 GMT" })).headers.get(
        "If-Modified-Since",
      ),
    ).toBeNull();
    const out = request({ "If-None-Match": '"v1-in"', "If-Modified-Since": "x" });
    expect(pillRequest(out)).toBe(out);
  });

  it("a browser holding either copy gets the label it should, through the real revalidation round trip", async () => {
    const { env } = world("open");
    const out = await get(env);
    expect(label(await out.text())).toBe("Sign In");
    const outTag = out.headers.get("ETag") ?? "";
    expect(outTag).toBe('"vopenprivacy"');

    // Signed out, then signs in: the signed-out validator must not revalidate the signed-in page.
    const afterSignIn = await get(env, { ...IN, "If-None-Match": outTag });
    expect(afterSignIn.status).toBe(200);
    expect(label(await afterSignIn.text())).toBe("Library");
    const inTag = afterSignIn.headers.get("ETag") ?? "";
    expect(inTag).toBe(`${outTag.slice(0, -1)}-in"`);

    // The signed-in copy revalidates to a 304 that keeps its own validator.
    const again = await get(env, { ...IN, "If-None-Match": inTag });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(inTag);

    // Signed out again: the signed-in validator must not revalidate the signed-out page.
    const signedOut = await get(env, { "If-None-Match": inTag });
    expect(signedOut.status).toBe(200);
    expect(label(await signedOut.text())).toBe("Sign In");
    expect(signedOut.headers.get("ETag")).toBe(outTag);

    // And the signed-out copy still revalidates for a signed-out visitor.
    expect((await get(env, { "If-None-Match": outTag })).status).toBe(304);
  });
});

describe("pill sets Vary: Cookie on every open HTML response and never on preview", () => {
  it("open pages vary by cookie, signed in or not; the signed-in copy is private, always revalidated", async () => {
    const { env } = world("open");
    for (const headers of [{}, IN]) {
      const res = await get(env, headers);
      expect(res.headers.get("Vary")).toMatch(/\bCookie\b/);
      expect(res.headers.get("Cache-Control")).toBe(headers === IN ? "private, no-cache" : "no-cache");
      expect(res.headers.get("Content-Length")).toBeNull();
    }
  });

  it("a signed-in range request is answered whole, and a signed-in HEAD has no body", async () => {
    const { env, seen } = world("open");
    const ranged = await get(env, { ...IN, Range: "bytes=0-9", "If-Range": '"x"' });
    expect(ranged.status).toBe(200);
    expect(label(await ranged.text())).toBe("Library");
    expect(seen.at(-1)?.headers.get("Range")).toBeNull();
    expect(seen.at(-1)?.headers.get("If-Range")).toBeNull();
    const head = await servePage(new Request(`${ORIGIN}/privacy`, { method: "HEAD", headers: IN }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("the open 404 has one -in suffix on its ETag", async () => {
    const { env } = world("open");
    const res = await get(env, { ...IN, Accept: "text/html" }, "/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("ETag")).toMatch(/[^n]-in"$/);
  });

  it("preview serves today's file with no Vary and no rewrite, even for a visitor with the hint", async () => {
    const { env, seen } = world("preview");
    const res = await get(env, IN);
    expect(res.headers.get("Vary")).toBeNull();
    expect(await res.text()).toBe(BODY);
    expect(new URL(seen.at(-1)?.url ?? "").pathname).toBe("/privacy");
  });

  it("the .html forms of an open-only page redirect in open, like every other page, and are the asset layer's in preview", async () => {
    const open = world("open").env;
    for (const path of ["/articles/features.html", "/articles/features/index.html"]) {
      const res = await get(open, {}, `${path}?a=1`);
      expect(res.status, path).toBe(307);
      expect(res.headers.get("Location"), path).toBe("/articles/features?a=1");
    }
    const preview = await get(world("preview").env, {}, "/articles/features.html");
    expect(preview.status).not.toBe(307);
  });

  it("a 304 for a variant is a revalidation, not a redirect fault", async () => {
    const { env } = world("open");
    const first = await get(env);
    const res = await get(env, { "If-None-Match": first.headers.get("ETag") ?? "" });
    expect(res.status).toBe(304);
  });

  it.each(["open", "preview"] as const)("%s: asking for /404 by name answers 404, and /404.html too", async (mode) => {
    const { env } = world(mode);
    for (const path of ["/404", "/404.html"]) {
      const res = await get(env, { Accept: "text/html" }, path);
      expect(res.status, path).toBe(404);
    }
  });

  it("the open 404 page carries the pill state too, and is never revalidated into today's 404", async () => {
    const { env } = world("open");
    const res = await get(env, { ...IN, Accept: "text/html", "If-None-Match": '"vopen404-in"' }, "/nope");
    expect(res.status).toBe(404);
    expect(label(await res.text())).toBe("Library");
  });
});
