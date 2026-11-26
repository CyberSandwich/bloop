import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DYNAMIC_PAGES, pageCsp } from "../../src/worker/headers.ts";
import { AUTH_SHELLS, MEMBER_PAGES } from "../../src/worker/page-registry.ts";
import { checksFor, main, missesFor, NOINDEX_META, probeForms, registryFrom, run } from "../../tools/live-check.mjs";

type Observed = { status: number; headers: Record<string, string>; body: string };
const ok = (over: Partial<Observed> = {}): Observed => ({ status: 200, headers: {}, body: "", ...over });
const ORIGIN = "https://site.example";
const FILES = "https://files.example";

/** A small registry: one plain page, one noindex page, one dynamic page, a shell with and without its file. */
const fixture = {
  pages: [
    { path: "/", noindex: false },
    { path: "/code", noindex: true },
    { path: "/s", noindex: true },
  ],
  shells: [
    { path: "/signin", exists: true },
    { path: "/invite", exists: false },
  ],
  members: ["/library"],
  gated: ["/library", "/open"],
  lazy: ["/js/core/poll.js"],
  headersFile:
    "/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'none'\n\n/s\n  ! Content-Security-Policy\n  Content-Security-Policy: static-s\n",
  fileOrigin: FILES,
  uploadMode: "proxy",
};
const byWhat = (what: string) => {
  const c = checksFor(fixture, { origin: ORIGIN, mode: "preview" }).find((x) => x.what === what);
  if (!c) throw new Error(`no check ${what}`);
  return c;
};

describe("live-check: matching a response against what is expected", () => {
  it("a response that meets every expectation has no misses", () => {
    const expect_ = {
      status: 200,
      header: { a: "1" },
      headerNot: { b: "x" },
      headerAbsent: ["c"],
      body: "yes",
      bodyNot: "no",
      contentType: "text/javascript",
    };
    expect(
      missesFor(
        expect_,
        ok({ headers: { a: "1", b: "y", "content-type": "text/javascript; charset=utf-8" }, body: "yes" }),
      ),
    ).toEqual([]);
  });

  it("each kind of miss is named once", () => {
    const expect_ = {
      status: 404,
      header: { a: "1" },
      headerNot: { b: "x" },
      headerAbsent: ["c"],
      body: "yes",
      bodyNot: "no",
      contentType: "text/javascript",
    };
    expect(missesFor(expect_, ok({ headers: { b: "x", c: "set", "content-type": "text/html" }, body: "no" }))).toEqual([
      "status 200, want 404",
      'a null, want "1"',
      'b must not be "x"',
      'c "set", want none',
      "body lacks yes",
      "body has no",
      'content-type "text/html", want text/javascript',
    ]);
  });
});

describe("live-check: what each page kind must answer", () => {
  it("a page answers 200 with its _headers, and noindex in its body exactly when its file has it", () => {
    expect(byWhat("page /").expect).toEqual({
      status: 200,
      header: { "x-frame-options": "DENY", "content-security-policy": "default-src 'none'" },
      headerAbsent: ["x-robots-tag"],
      bodyNot: NOINDEX_META,
    });
    expect(byWhat("page /code").expect.body).toBe(NOINDEX_META);
  });

  it("a dynamic page expects the policy completed with the file origin, not the static one", () => {
    expect(byWhat("page /s").expect.header?.["content-security-policy"]).toBe(
      pageCsp("/s", { fileOrigin: FILES, r2Endpoint: null }),
    );
    const direct = checksFor(
      { ...fixture, uploadMode: "direct", pages: [{ path: "/a", noindex: true }] },
      { origin: ORIGIN, mode: "preview" },
    );
    expect(DYNAMIC_PAGES["/a"]?.r2).toBe(true);
    expect(direct[0]?.expect.header).not.toHaveProperty("content-security-policy");
  });

  it("a sign-in page is noindex in preview and plain in open; with no file yet it is a 404", () => {
    expect(byWhat("sign-in page /signin (preview)").expect).toMatchObject({
      status: 200,
      header: { "x-robots-tag": "noindex" },
    });
    expect(byWhat("sign-in page /invite (preview)").expect).toMatchObject({
      status: 404,
      header: { "x-robots-tag": "noindex" },
    });
    const open = checksFor(fixture, { origin: ORIGIN, mode: "open" }).find(
      (c) => c.what === "sign-in page /signin (open)",
    );
    expect(open?.expect).toMatchObject({ status: 200, headerAbsent: ["x-robots-tag"] });
  });

  it("a member page signed out, and every encoded form of a gated path after its redirects, is the noindex 404", () => {
    expect(byWhat("member page /library signed out").expect).toEqual({ status: 404, body: NOINDEX_META });
    const gated = checksFor(fixture, { origin: ORIGIN, mode: "preview" }).filter((c) => c.what.startsWith("gated "));
    expect(gated).toHaveLength(probeForms("/library").length + probeForms("/open").length);
    for (const c of gated) expect(c).toMatchObject({ follow: true, expect: { status: 404, body: NOINDEX_META } });
  });

  it("a lazy module is served as JavaScript; the file origin's probe answers the site only, and the site has none", () => {
    expect(byWhat("lazy /js/core/poll.js")).toMatchObject({
      url: `${ORIGIN}/js/core/poll.js`,
      expect: { status: 200, contentType: "text/javascript" },
    });
    expect(byWhat("file origin /fo/ping from the site")).toMatchObject({
      url: `${FILES}/fo/ping`,
      headers: { Origin: ORIGIN },
      expect: { status: 204, header: { "access-control-allow-origin": ORIGIN, "cache-control": "no-store" } },
    });
    expect(byWhat("file origin /fo/ping from a foreign origin").expect.headerNot).toEqual({
      "access-control-allow-origin": "https://foreign.invalid",
    });
    expect(byWhat("file origin / sends visitors to the site").expect).toEqual({
      status: 301,
      header: { location: `${ORIGIN}/` },
    });
    expect(byWhat("the site has no /fo/ping").expect).toEqual({ status: 404 });
    expect(
      checksFor({ ...fixture, fileOrigin: null }, { origin: ORIGIN, mode: "preview" }).some((c) =>
        c.url.includes("/fo/"),
      ),
    ).toBe(false);
  });
});

describe("live-check: the encoded forms of a gated path", () => {
  it("covers encoded first letters in both cases, dot and slash tricks, the file form and another case", () => {
    expect(probeForms("/open")).toEqual([
      "/open",
      "/%6fpen",
      "/%6Fpen",
      "/%6fpen/",
      "/%2e/open",
      "//open",
      "/open/./privacy",
      "/%2Fopen",
      "/open.html",
      "/Open",
    ]);
  });

  it("a form that repeats another (a digit-only hex code) is sent once", () => {
    const forms = probeForms("/admin");
    expect(forms).toContain("/%61dmin");
    expect(new Set(forms).size).toBe(forms.length);
    expect(forms).toHaveLength(9);
  });
});

describe("live-check: the registry is the repo's, not a list in the tool", () => {
  const reg = registryFrom();

  it("every page file in public/ is checked unless the registry gates it, and every gated page is probed", () => {
    const files = readdirSync(new URL("../../public/", import.meta.url)).filter(
      (f) => f.endsWith(".html") && f !== "404.html",
    );
    const paths = files.map((f) => (f === "index.html" ? "/" : `/${f.slice(0, -5)}`));
    const gated = new Set([...AUTH_SHELLS, ...MEMBER_PAGES]);
    expect(reg.pages.map((p) => p.path).sort()).toEqual(paths.filter((p) => !gated.has(p)).sort());
    expect(reg.members).toEqual([...MEMBER_PAGES]);
    expect(reg.shells.map((s) => s.path)).toEqual([...AUTH_SHELLS]);
    expect(reg.gated).toEqual([...MEMBER_PAGES, "/open"]);
  });

  it("the lazy modules are the size budgets' lazy entries, and the file origin is wrangler's", () => {
    expect(reg.lazy).toContain("/js/core/copy-check.js");
    expect(reg.lazy.every((p) => p.startsWith("/js/") && p.endsWith(".js"))).toBe(true);
    expect(reg.fileOrigin).toMatch(/^https:\/\//);
  });
});

describe("live-check: running the checks", () => {
  const gated = {
    what: "gated /open as /%6fpen",
    url: `${ORIGIN}/%6fpen`,
    follow: true,
    expect: { status: 404, body: NOINDEX_META },
  };
  const notFound = ok({ status: 404, body: `<title>missing</title>${NOINDEX_META}` });

  it("sends the path byte for byte and follows a gated form's redirect to its end", async () => {
    const asked: string[] = [];
    const misses = await run([gated], async (url) => {
      asked.push(url);
      return url.endsWith("/%6fpen") ? ok({ status: 307, headers: { location: "/open" } }) : notFound;
    });
    expect(asked).toEqual([`${ORIGIN}/%6fpen`, `${ORIGIN}/open`]);
    expect(misses).toEqual([]);
  });

  it("a gate bypass, an encoded form that ends on a page, is a miss naming where it ended", async () => {
    const misses = await run([gated], async (url) =>
      url.endsWith("/%6fpen") ? ok({ status: 307, headers: { location: "/open/" } }) : ok({ body: "<h1>open</h1>" }),
    );
    expect(misses).toEqual([
      `gated /open as /%6fpen: status 200, want 404 (at ${ORIGIN}/open/)`,
      `gated /open as /%6fpen: body lacks ${NOINDEX_META} (at ${ORIGIN}/open/)`,
    ]);
  });

  it("a check that does not follow judges the redirect itself, and a redirect loop stops", async () => {
    const redirect = ok({ status: 301, headers: { location: "/again" } });
    expect(await run([{ what: "root", url: `${FILES}/`, expect: { status: 301 } }], async () => redirect)).toEqual([]);
    let calls = 0;
    const loop = await run([gated], async () => {
      calls++;
      return redirect;
    });
    expect(calls).toBe(6);
    expect(loop[0]).toMatch(/^gated \/open as \/%6fpen: status 301, want 404/);
  });

  it("a request that fails is a miss, never a pass", async () => {
    expect(
      await run([gated], async () => {
        throw new Error("timed out");
      }),
    ).toEqual(["gated /open as /%6fpen: request failed: timed out"]);
  });

  it("the CLI exits 64 on an origin with a path, a missing origin or an unknown mode, before any request", async () => {
    const never = async (): Promise<Observed> => {
      throw new Error("no request expected");
    };
    expect(await main([`${ORIGIN}/x`], never)).toBe(64);
    expect(await main([], never)).toBe(64);
    expect(await main([ORIGIN, "--mode", "live"], never)).toBe(64);
  });

  it("the CLI exits 1 on a miss and 0 when every check passes", async () => {
    expect(await main([ORIGIN], async () => ok({ status: 500 }))).toBe(1);
    const reg = registryFrom();
    const answers = new Map(
      checksFor(reg, { origin: ORIGIN, mode: "preview" }).map((c) => [
        c.url + JSON.stringify(c.headers ?? {}),
        c.expect,
      ]),
    );
    const perfect = async (url: string, headers: Record<string, string>): Promise<Observed> => {
      const e = answers.get(url + JSON.stringify(headers)) ?? {};
      const h: Record<string, string> = { ...(e.header ?? {}) };
      if (e.contentType) h["content-type"] = e.contentType;
      return { status: e.status ?? 204, headers: h, body: e.body ?? "" };
    };
    expect(await main([ORIGIN], perfect)).toBe(0);
  });
});
