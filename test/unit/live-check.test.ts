import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSP, pageCsp } from "../../src/worker/headers.ts";
import { AUTH_SHELLS, MEMBER_PAGES } from "../../src/worker/page-registry.ts";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import {
  checksFor,
  DROPS,
  dropMisses,
  expandLazy,
  globRegex,
  linksIn,
  main,
  missesFor,
  NOINDEX_META,
  probeForms,
  rawGet,
  registryFrom,
  run,
  unhashed,
} from "../../tools/live-check.mjs";
import { CLEAN, HOSTILE } from "../pdf-corpus.ts";
import { SPAWN_TIMEOUT } from "./spawn.ts";

type Observed = { status: number; headers: Record<string, string>; body: string };
type Get = (url: string, headers: Record<string, string>) => Promise<Observed>;
const ok = (over: Partial<Observed> = {}): Observed => ({ status: 200, headers: {}, body: "", ...over });
const html = (body: string) => ok({ headers: { "content-type": "text/html" }, body });
const ORIGIN = "https://site.example";
const FILES = "https://files.example";
const R2 = "https://abc123.eu.r2.cloudflarestorage.com";

type Reg = ReturnType<typeof registryFrom>;
/** A small registry: a plain page, a noindex page, a dynamic page, a shell and a member page with and without files. */
const fixture: Reg = {
  pages: [
    { path: "/", noindex: false },
    { path: "/code", noindex: true },
    { path: "/s", noindex: true },
  ],
  shells: [
    { path: "/signin", exists: true },
    { path: "/invite", exists: false },
  ],
  members: [
    { path: "/library", exists: true },
    { path: "/admin", exists: false },
  ],
  variants: [],
  lazy: [
    { path: "/js/core/poll.js", type: "text/javascript" },
    { path: "/css/length.css", type: "text/css" },
  ],
  typeFiles: ["/js/types.d.ts"],
  immutable: ["/fonts/a-0123abcd.woff2", "/js/vendor/q-89abcdef/q.js"],
  headersFile:
    "/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'none'\n\n/s\n  ! Content-Security-Policy\n  Content-Security-Policy: static-s\n\n" +
    "/fonts/*\n  Cache-Control: forever\n\n/js/vendor/*\n  Cache-Control: forever\n\n" +
    "https://files.example/*\n  ! Content-Security-Policy\n  Content-Security-Policy: sandboxed\n",
  publicOrigin: ORIGIN,
  publicHost: new URL(ORIGIN).host,
  fileOrigin: FILES,
  uploadMode: "proxy",
};
const find = (checks: ReturnType<typeof checksFor>, what: string) => {
  const c = checks.find((x) => x.what === what);
  if (!c) throw new Error(`no check ${what}`);
  return c;
};
const preview = (reg: Reg = fixture) => checksFor(reg, "preview");
const open = (reg: Reg = fixture) => checksFor(reg, "open");

describe("live-check: matching a response against what is expected", () => {
  const all = {
    status: 200,
    header: { a: "1" },
    headerNot: { b: "x" },
    headerAbsent: ["c"],
    body: "yes",
    bodyNot: "no",
    contentType: "text/javascript",
  };

  it("a response that meets every expectation has no misses", () => {
    const o = ok({ headers: { a: "1", b: "y", "content-type": "text/javascript; charset=utf-8" }, body: "yes" });
    expect(missesFor(all, o)).toEqual([]);
  });

  it("each kind of miss is named once", () => {
    const o = ok({ status: 404, headers: { b: "x", c: "set", "content-type": "text/html" }, body: "no" });
    expect(missesFor(all, o)).toEqual([
      "status 404, want 200",
      'a null, want "1"',
      'b must not be "x"',
      'c "set", want none',
      "body lacks yes",
      "body has no",
      'content-type "text/html", want text/javascript',
    ]);
  });

  it("success means any 2xx; a 3xx or 404 is a miss", () => {
    expect(missesFor({ success: true }, ok({ status: 204 }))).toEqual([]);
    expect(missesFor({ success: true }, ok({ status: 302 }))).toEqual(["status 302, want 2xx"]);
    expect(missesFor({ success: true }, ok({ status: 404 }))).toEqual(["status 404, want 2xx"]);
  });

  it("a CSP compared without the R2 host passes with any account's endpoint and fails on any other change", () => {
    const want = "default-src 'none'; connect-src 'self'";
    const csp = (v: string) => ok({ headers: { "content-security-policy": v } });
    expect(missesFor({ cspIgnoringR2: want }, csp(`default-src 'none'; connect-src 'self' ${R2}`))).toEqual([]);
    expect(
      missesFor({ cspIgnoringR2: want }, csp("default-src 'none'; connect-src 'self' https://evil.example")),
    ).toHaveLength(1);
    expect(missesFor({ cspIgnoringR2: want }, ok())).toHaveLength(1);
  });
});

describe("live-check: what each page kind answers, by mode", () => {
  it("a page answers 200 with its _headers, no robots header, and noindex in its body exactly when its file has it", () => {
    expect(find(preview(), "page /")).toEqual({
      what: "page /",
      url: `${ORIGIN}/`,
      links: true,
      expect: {
        status: 200,
        header: { "x-frame-options": "DENY", "content-security-policy": "default-src 'none'" },
        headerAbsent: ["x-robots-tag"],
        bodyNot: NOINDEX_META,
      },
    });
    expect(find(preview(), "page /code").expect.body).toBe(NOINDEX_META);
    expect(find(open(), "page /code").expect.body).toBe(NOINDEX_META);
  });

  it("a dynamic page expects its policy completed with the file origin; in direct upload mode, all but the R2 host", () => {
    expect(find(preview(), "page /s").expect.header?.["content-security-policy"]).toBe(
      pageCsp("/s", { fileOrigin: FILES, r2Endpoint: null }),
    );
    const direct = preview({ ...fixture, uploadMode: "direct", pages: [{ path: "/a", noindex: true }] })[0];
    expect(direct?.expect.header).not.toHaveProperty("content-security-policy");
    expect(direct?.expect.cspIgnoringR2).toBe(pageCsp("/a", { fileOrigin: FILES, r2Endpoint: null }));
  });

  it("a sign-in page is noindex in preview and plain in open; with no file yet it is a 404 either way", () => {
    expect(find(preview(), "sign-in page /signin (preview)").expect).toMatchObject({
      status: 200,
      header: { "x-robots-tag": "noindex" },
    });
    expect(find(preview(), "sign-in page /invite (preview)").expect).toMatchObject({
      status: 404,
      header: { "x-robots-tag": "noindex" },
    });
    expect(find(open(), "sign-in page /signin (open)").expect).toMatchObject({
      status: 200,
      headerAbsent: ["x-robots-tag"],
    });
    expect(find(open(), "sign-in page /invite (open)").expect).toMatchObject({ status: 404 });
  });

  it("preview: a member page is probed in every form as the noindex 404, the plain path once", () => {
    const library = preview().filter((c) => c.what.startsWith("gated /library "));
    expect(library.map((c) => c.url)).toEqual(probeForms("/library").map((f) => `${ORIGIN}${f}`));
    expect(preview().filter((c) => c.url === `${ORIGIN}/library`)).toHaveLength(1);
    for (const c of library) expect(c).toMatchObject({ follow: true, expect: { status: 404, body: NOINDEX_META } });
  });

  it("open: a member page is served to anyone, as a page when its file exists, and only /open is probed", () => {
    expect(find(open(), "member page /library signed out (open)").expect).toMatchObject({ status: 200 });
    expect(find(open(), "member page /admin signed out (open)").expect).toEqual({ status: 404 });
    const gated = open().filter((c) => c.what.startsWith("gated "));
    expect(gated.map((c) => c.url)).toEqual(probeForms("/open").map((f) => `${ORIGIN}${f}`));
  });

  it("variants: open-only is probed in preview and a page in open; preview-only is a page, then a 301", () => {
    const reg: Reg = {
      ...fixture,
      pages: [...fixture.pages, { path: "/old", noindex: false }, { path: "/pricing", noindex: false }],
      variants: [
        { path: "/new", kind: "open-only" },
        { path: "/old", kind: "preview-only", to: "/new" },
        { path: "/pricing", kind: "both" },
      ],
    };
    expect(preview(reg).filter((c) => c.what.startsWith("gated /new "))).toHaveLength(probeForms("/new").length);
    expect(find(open(reg), "open-only /new (open)").expect).toMatchObject({ status: 200 });
    expect(open(reg).some((c) => c.what.startsWith("gated /new "))).toBe(false);
    expect(find(preview(reg), "page /old").expect.status).toBe(200);
    expect(find(open(reg), "preview-only /old (open)").expect).toEqual({ status: 301, header: { location: "/new" } });
    // A `both` page serves its open file in open, whose robots line the preview file does not tell.
    expect(find(preview(reg), "page /pricing").expect.bodyNot).toBe(NOINDEX_META);
    expect(find(open(reg), "page /pricing").expect).not.toHaveProperty("bodyNot");
  });

  it("a lazy module is served with its type; the file origin's probe answers the site only, and the site has none", () => {
    expect(find(preview(), "lazy /js/core/poll.js").expect).toEqual({ status: 200, contentType: "text/javascript" });
    expect(find(preview(), "lazy /css/length.css").expect).toEqual({ status: 200, contentType: "text/css" });
    expect(find(preview(), "file origin /fo/ping from the site")).toMatchObject({
      url: `${FILES}/fo/ping`,
      headers: { Origin: ORIGIN },
      expect: { status: 204, header: { "access-control-allow-origin": ORIGIN, "cache-control": "no-store" } },
    });
    expect(find(preview(), "file origin /fo/ping from a foreign origin").expect.headerNot).toEqual({
      "access-control-allow-origin": "https://foreign.invalid",
    });
    expect(find(preview(), "file origin / sends visitors to the site").expect).toEqual({
      status: 301,
      header: { location: `${ORIGIN}/` },
    });
    expect(find(preview(), "the site has no /fo/ping").expect).toEqual({ status: 404 });
    expect(preview({ ...fixture, fileOrigin: null }).some((c) => c.url.includes("/fo/"))).toBe(false);
  });

  it("a signed-out upload list is refused with auth_required in either mode, file origin or not", () => {
    const want = { url: `${ORIGIN}/api/uploads`, expect: { status: 401, body: '"code":"auth_required"' } };
    for (const checks of [preview(), open(), preview({ ...fixture, fileOrigin: null })])
      expect(find(checks, "a signed-out upload list is refused with auth_required")).toMatchObject(want);
  });
});

describe("live-check: files a build that drops dotfiles or leaks sources would get wrong", () => {
  it("security.txt is always asked for, as text with a Contact line; each type declaration must 404", () => {
    expect(find(preview(), "security.txt")).toEqual({
      what: "security.txt",
      url: `${ORIGIN}/.well-known/security.txt`,
      expect: { status: 200, contentType: "text/plain", body: "Contact:" },
    });
    expect(find(open({ ...fixture, typeFiles: [] }), "security.txt").expect.body).toBe("Contact:");
    expect(find(preview(), "type file /js/types.d.ts is not served")).toMatchObject({ expect: { status: 404 } });
  });

  it("MODE-01: the launch manifest is asked for in both modes and must be the noindex 404", () => {
    for (const checks of [preview(), open()]) {
      expect(find(checks, "launch manifest is not served")).toMatchObject({
        url: `${ORIGIN}/_launch.json`,
        expect: { status: 404, body: NOINDEX_META },
      });
    }
  });

  it("the registry finds the repo's type declarations, vendored ones included", () => {
    const { typeFiles } = registryFrom();
    expect(typeFiles).toContain("/js/types.d.ts");
    expect(typeFiles.some((p) => p.startsWith("/js/vendor/") && p.endsWith(".d.ts"))).toBe(true);
  });
});

describe("live-check: content-hashed names and the file origin's static answers", () => {
  it("each immutable file answers its cache rule, and its unhashed name 404s", () => {
    const checks = preview();
    expect(find(checks, "immutable /fonts/a-0123abcd.woff2")).toEqual({
      what: "immutable /fonts/a-0123abcd.woff2",
      url: `${ORIGIN}/fonts/a-0123abcd.woff2`,
      expect: { status: 200, header: { "cache-control": "forever" } },
    });
    expect(find(checks, "unhashed /fonts/a.woff2 is gone")).toMatchObject({
      url: `${ORIGIN}/fonts/a.woff2`,
      expect: { status: 404 },
    });
    expect(find(open(), "unhashed /js/vendor/q.js is gone").url).toBe(`${ORIGIN}/js/vendor/q.js`);
  });

  it("takes the hash out of a file name or drops a hashed folder, and refuses a name with no hash", () => {
    expect(unhashed("/fonts/inter-latin-cc089b5d.woff2")).toBe("/fonts/inter-latin.woff2");
    expect(unhashed("/fonts/inter-90ef5e81.LICENSE.txt")).toBe("/fonts/inter.LICENSE.txt");
    expect(unhashed("/js/vendor/uqr-1289037a/uqr.js")).toBe("/js/vendor/uqr.js");
    expect(unhashed("/js/vendor/x-1289037a/y-cc089b5d.js")).toBe("/js/vendor/y.js");
    expect(() => unhashed("/fonts/inter-latin.woff2")).toThrow(/no content hash/);
    expect(() => unhashed("/fonts/a-0123ABCD.woff2")).toThrow(/no content hash/);
    expect(() => preview({ ...fixture, immutable: ["/fonts/plain.woff2"] })).toThrow(/no content hash/);
  });

  it("a static 404 on the file origin must carry the CSP _headers gives that host", () => {
    expect(find(preview(), "file origin static 404 carries the file-origin CSP")).toEqual({
      what: "file origin static 404 carries the file-origin CSP",
      url: `${FILES}/js/live-check-missing.js`,
      expect: { status: 404, header: { "content-security-policy": "sandboxed" } },
    });
    expect(preview({ ...fixture, fileOrigin: null }).some((c) => c.what.startsWith("file origin static"))).toBe(false);
  });

  it("the registry lists every immutable file but no type declaration, and the real file origin is sandboxed", () => {
    const reg = registryFrom();
    expect(reg.immutable).toEqual(
      expect.arrayContaining(["/fonts/inter-latin-cc089b5d.woff2", "/js/vendor/uqr-1289037a/uqr.js"]),
    );
    expect(reg.immutable.some((p) => p.endsWith(".d.ts") || !/\.\w+$/.test(p))).toBe(false);
    const fo = find(checksFor(reg, "preview"), "file origin static 404 carries the file-origin CSP");
    expect(fo.expect.header?.["content-security-policy"]).toMatch(/\bsandbox\b/);
  });
});

describe("live-check: the encoded forms of a gated path", () => {
  it("covers encoded letters once and twice, dot segments onto the path, slash and backslash, file forms, cases", () => {
    expect(probeForms("/open")).toEqual([
      "/open",
      "/open/",
      "/%6fpen",
      "/%6Fpen",
      "/%6fpen/",
      "/%256fpen",
      "/%2e/open",
      "/privacy/../open",
      "/x/%2e%2e/open",
      "//open",
      "/%2Fopen",
      "/%5copen",
      "/\\open",
      "/open.html",
      "/open/index.html",
      "/Open",
      "/Open.HTML",
    ]);
  });

  it("a form that repeats another (a digit-only hex code) is sent once", () => {
    const forms = probeForms("/admin");
    expect(forms).toContain("/%61dmin");
    expect(new Set(forms).size).toBe(forms.length);
    expect(forms).toHaveLength(probeForms("/open").length - 1);
  });
});

describe("live-check: the registry is the repo's, not a list in the tool", { timeout: SPAWN_TIMEOUT }, () => {
  const reg = registryFrom();

  it("every tracked page file in public/, at any depth, is checked unless the registry gates it", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "public/*.html"], {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f && f !== "public/404.html" && !f.startsWith("public/open/"))
      .map((f) => `/${f.slice("public/".length).replace(/\.html$/, "")}`.replace(/^\/index$/, "/"));
    const gated = new Set([...AUTH_SHELLS, ...MEMBER_PAGES]);
    expect(reg.pages.map((p) => p.path).sort()).toEqual(tracked.filter((p) => !gated.has(p)).sort());
    expect(reg.pages.some((p) => p.path.startsWith("/articles/"))).toBe(true);
    expect(reg.members.map((m) => m.path)).toEqual([...MEMBER_PAGES]);
    expect(reg.shells.map((s) => s.path)).toEqual([...AUTH_SHELLS]);
  });

  it("the lazy modules are the budgets' lazy entries, CSS included, and the origins are wrangler's", () => {
    expect(reg.lazy).toContainEqual({ path: "/js/core/copy-check.js", type: "text/javascript" });
    expect(reg.lazy).toContainEqual({ path: "/css/length.css", type: "text/css" });
    expect(reg.publicOrigin).toBe("https://bloop.here");
    expect(reg.publicHost).toBe("bloop.here");
    expect(reg.fileOrigin).toMatch(/^https:\/\//);
  });

  it("a lazy glob matches the way size-limit reads it; a brace or bracket glob is refused", () => {
    expect(globRegex("js/**/*.js").test("js/core/a.js")).toBe(true);
    expect(globRegex("js/**/*.js").test("js/a.js")).toBe(true);
    expect(globRegex("js/*.js").test("js/core/a.js")).toBe(false);
    expect(globRegex("css/?.css").test("css/a.css")).toBe(true);
    expect(() => globRegex("js/{a,b}.js")).toThrow(/cannot expand/);
  });

  it("a lazy entry maps dist/ to public/; a glob that names no file, or a path outside dist/, throws", () => {
    const files = ["js/core/a.js", "js/core/b.js", "css/c.css"];
    expect(expandLazy("dist/css/c.css", files)).toEqual(["css/c.css"]);
    expect(expandLazy("dist/js/core/*.js", files)).toEqual(["js/core/a.js", "js/core/b.js"]);
    expect(() => expandLazy("dist/js/typo/*.js", files)).toThrow(/matches no file/);
    expect(() => expandLazy("public/js/core/a.js", files)).toThrow(/not under dist/);
  });

  it("the registry lists cannot be changed at run time", () => {
    expect(Object.isFrozen(MEMBER_PAGES)).toBe(true);
    expect(Object.isFrozen(AUTH_SHELLS)).toBe(true);
  });
});

describe("live-check: links", () => {
  it("takes same-origin href and src targets without fragments, once each, and skips other hosts and schemes", () => {
    const body = `<a href="/privacy#x">a</a><img src='/img/a.png'><a href="https://other.example/x">o</a>
      <a href="mailto:a@b">m</a><a href="#top">t</a><link href="https://site.example/css/a.css?v=1"><a href="/privacy">p</a>`;
    expect(linksIn(body, `${ORIGIN}/`)).toEqual(["/privacy", "/img/a.png", "/css/a.css?v=1"]);
  });

  it("every link on a checked page must answer 2xx after same-host redirects; a 404 or a hop off-host is a miss", async () => {
    const page = { what: "page /", url: `${ORIGIN}/`, links: true, expect: { status: 200 } };
    const answers: Record<string, Observed> = {
      "/": html('<a href="/ok">x</a><a href="/moved">y</a><a href="/gone">z</a><a href="/away">w</a>'),
      "/ok": ok(),
      "/moved": ok({ status: 301, headers: { location: "/ok" } }),
      "/gone": ok({ status: 404 }),
      "/away": ok({ status: 302, headers: { location: "https://elsewhere.example/" } }),
    };
    const get: Get = async (url) => answers[new URL(url).pathname] ?? ok({ status: 500 });
    const result = await run([page], get);
    expect(result.checks).toBe(5);
    expect(result.misses).toEqual([
      `link /gone (on ${ORIGIN}/): status 404, want 2xx`,
      `link /away (on ${ORIGIN}/): redirected off its origin to https://elsewhere.example/`,
    ]);
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

  it("follows a gated form's redirect to its end", async () => {
    const asked: string[] = [];
    const result = await run([gated], async (url) => {
      asked.push(url);
      return url.endsWith("/%6fpen") ? ok({ status: 307, headers: { location: "/open" } }) : notFound;
    });
    expect(asked).toEqual([`${ORIGIN}/%6fpen`, `${ORIGIN}/open`]);
    expect(result.misses).toEqual([]);
  });

  it("a gate bypass, an encoded form that ends on a page, is a miss naming where it ended", async () => {
    const result = await run([gated], async (url) =>
      url.endsWith("/%6fpen") ? ok({ status: 307, headers: { location: "/open/" } }) : ok({ body: "<h1>open</h1>" }),
    );
    expect(result.misses).toEqual([
      `gated /open as /%6fpen: status 200, want 404 (at ${ORIGIN}/open/)`,
      `gated /open as /%6fpen: body lacks ${NOINDEX_META} (at ${ORIGIN}/open/)`,
    ]);
  });

  it("a redirect to another host is a miss, and that host is never asked, even if it would answer the 404", async () => {
    const asked: string[] = [];
    const result = await run([gated], async (url) => {
      asked.push(url);
      return url.startsWith(ORIGIN)
        ? ok({ status: 302, headers: { location: "https://elsewhere.example/x" } })
        : notFound;
    });
    expect(asked).toEqual([`${ORIGIN}/%6fpen`]);
    expect(result.misses).toEqual(["gated /open as /%6fpen: redirected off its origin to https://elsewhere.example/x"]);
  });

  it("a check that does not follow judges the redirect itself, and a redirect loop stops", async () => {
    const redirect = ok({ status: 301, headers: { location: "/again" } });
    const root = { what: "root", url: `${FILES}/`, expect: { status: 301 } };
    expect((await run([root], async () => redirect)).misses).toEqual([]);
    let calls = 0;
    const loop = await run([gated], async () => {
      calls++;
      return redirect;
    });
    expect(calls).toBe(6);
    expect(loop.misses[0]).toMatch(/^gated \/open as \/%6fpen: status 301, want 404/);
  });

  it("a request that fails twice is a miss, never a pass; one that fails once is sent again and judged", async () => {
    let calls = 0;
    const result = await run([gated], async () => {
      calls++;
      throw new Error("timed out");
    });
    expect(calls).toBe(2);
    expect(result.misses).toEqual(["gated /open as /%6fpen: request failed: timed out"]);
    let first = true;
    const blip = await run([gated], async () => {
      if (first) {
        first = false;
        throw new Error("tunnel timed out");
      }
      return notFound;
    });
    expect(blip.misses).toEqual([]);
  });

  it("an answer that is wrong is never sent again", async () => {
    let calls = 0;
    await run([gated], async () => {
      calls++;
      return ok({ status: 500 });
    });
    expect(calls).toBe(1);
  });
});

describe("live-check: rawGet against a local server", () => {
  const seen: string[] = [];
  let base = "";
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("Set-Cookie", ["a=1", "b=2"]);
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("missing");
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends each probe path byte for byte, where URL parsing (and so fetch) would resolve it first", async () => {
    const forms = ["/%2e/open", "/privacy/../open", "/x/%2e%2e/open", "//open", "/\\open", "/%256fpen"];
    for (const f of forms) await rawGet(`${base}${f}`, {});
    expect(seen.slice(-forms.length)).toEqual(forms);
    expect(new URL(`${base}/x/%2e%2e/open`).pathname).toBe("/open");
  });

  it("returns status, body and lower-case headers, with a repeated header joined", async () => {
    const o = await rawGet(`${base}/x`, { Origin: ORIGIN });
    expect(o.status).toBe(404);
    expect(o.body).toBe("missing");
    expect(o.headers["content-type"]).toBe("text/html");
    expect(o.headers["set-cookie"]).toBe("a=1, b=2");
  });
});

describe("live-check: the CLI", () => {
  const never: Get = async () => {
    throw new Error("no request expected");
  };

  it("exits 64 on a missing origin, an unknown mode, or an origin that is not PUBLIC_ORIGIN, before any request", async () => {
    expect(await main([], never)).toBe(64);
    expect(await main(["https://bloop.here", "--mode", "live"], never)).toBe(64);
    expect(await main(["https://bloop.here/x"], never)).toBe(64);
    expect(await main([ORIGIN], never)).toBe(64);
  });

  it("exits 1 on a miss, and 0 when every check passes against the real registry", async () => {
    expect(await main(["https://bloop.here"], async () => ok({ status: 500 }), demo().io)).toBe(1);
    const checks = checksFor(registryFrom(), "preview");
    // Fixed values from the repo, so a registry or an expectation gone empty or wrong fails here: /library and /open
    // get 17 forms each, /account, /admin and the open-only /articles/features 16 (their hex code is digits only).
    expect(checks.filter((c) => c.what.startsWith("gated ")).length).toBe(82);
    expect(find(checks, "page /").expect.header?.["content-security-policy"]).toBe(CSP.landing);
    expect(find(checks, "page /s").expect.header?.["content-security-policy"]).toContain(
      "https://bloop.dsap.workers.dev",
    );
    const answers = new Map(checks.map((c) => [c.url + JSON.stringify(c.headers ?? {}), c.expect]));
    const perfect: Get = async (url, headers) => {
      const e = answers.get(url + JSON.stringify(headers)) ?? {};
      const h: Record<string, string> = { ...(e.header ?? {}) };
      if (e.contentType) h["content-type"] = e.contentType;
      return { status: e.status ?? 204, headers: h, body: e.body ?? "" };
    };
    expect(await main(["https://bloop.here"], perfect, demo().io)).toBe(0);
    expect(
      await main(["https://bloop.here"], perfect, demo({ drop: () => ok({ body: '{"state":"offered"}' }) }).io),
    ).toBe(1);
  });
});

/** A demo site for the drop flow: each step answers as given, and every request is logged. */
function demo(
  over: {
    create?: Observed;
    claim?: Observed;
    drop?: (bytes: Uint8Array) => Observed;
    end?: Observed;
    socket?: "fail";
  } = {},
) {
  const log: string[] = [];
  const closed: string[] = [];
  const files: string[] = [];
  const send = async (method: string, url: string, headers: Record<string, string>, body: string | Uint8Array) => {
    const path = new URL(url).pathname;
    log.push(`${method} ${path}${headers.Authorization ? ` ${headers.Authorization}` : ""}`);
    if (path === "/api/screens") return over.create ?? ok({ status: 201, body: '{"sid":"ref1.secret"}' });
    if (path === "/api/claim") return over.claim ?? ok({ body: '{"pid":"pid1"}' });
    if (path === "/api/drop") {
      files.push(`${headers["X-Bloop-Name"]} ${headers["Content-Type"]}`);
      const bytes = body as Uint8Array;
      if (over.drop) return over.drop(bytes);
      // A site that answers each drop as it should: the code its expectation names, or offered.
      const code = /"code":"(\w+)"/.exec(DROPS.find((x) => x.bytes === bytes)?.expect.body ?? "")?.[1];
      return code ? ok({ status: 422, body: `{"code":"${code}"}` }) : ok({ body: '{"state":"offered"}' });
    }
    if (path === "/api/screen/end") return over.end ?? ok({ body: "{}" });
    throw new Error(`unexpected ${method} ${path}`);
  };
  const socket = async (url: string, _origin: string, sid: string) => {
    log.push(`WS ${new URL(url).pathname}${new URL(url).search} ${sid}`);
    if (over.socket === "fail") throw new Error("screen socket refused");
    return { code: "123456", close: () => closed.push(sid) };
  };
  return { io: { send, socket }, log, closed, files };
}

describe("live-check: guest drops on a demo screen", () => {
  const drop = (what: string) => {
    const d = DROPS.find((x) => x.what === `guest drop of ${what}`);
    if (!d) throw new Error(`no drop ${what}`);
    return d;
  };
  const one = (what: string) => [drop(what)];

  it("each hostile drop must be refused with its code and the clean one offered, each on its own ended screen", async () => {
    const d = demo();
    expect(await dropMisses(ORIGIN, DROPS, d.io)).toEqual([]);
    const flow = [
      "POST /api/screens",
      "WS /api/screen/ws?ref=ref1 ref1.secret",
      "POST /api/claim",
      "PUT /api/drop Bearer pid1",
      "POST /api/screen/end Bearer ref1.secret",
    ];
    expect(d.log).toEqual(DROPS.flatMap(() => flow));
    expect(d.closed).toEqual(DROPS.map(() => "ref1.secret"));
    expect(DROPS.map((x) => x.expect)).toEqual([
      { status: 422, body: '"code":"macro_content"' },
      { status: 422, body: '"code":"bad_structure"' },
      { status: 422, body: '"code":"bad_structure"' },
      { status: 200, body: '"state":"offered"' },
      { status: 200, body: '"state":"offered"' },
    ]);
    const deck = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    expect(d.files).toEqual([...DROPS.slice(0, -1).map(() => "Paper.pdf application/pdf"), `Deck.pptx ${deck}`]);
  });

  it("the deck drop is a valid 5 MiB deck: a mid-size single PUT the site must still offer", async () => {
    const deck = drop("a 5 MiB deck (one stored image)").bytes;
    expect(deck.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(deck.length).toBeLessThan(6 * 1024 * 1024);
    const object = { size: deck.length, read: async (at: number, n: number) => deck.slice(at, at + n) };
    expect(await validate(object, "pptx")).toEqual({ ok: true, type: "pptx" });
  });

  it("a hostile drop the site accepts, or refuses with another code, is a miss", async () => {
    const js = "a PDF with /JavaScript in an object stream";
    const accepted = demo({ drop: () => ok({ body: '{"state":"offered"}' }) });
    expect(await dropMisses(ORIGIN, one(js), accepted.io)).toEqual([
      `guest drop of ${js}: status 200, want 422`,
      `guest drop of ${js}: body lacks "code":"macro_content"`,
    ]);
    const padded = "a PDF with forged object marks in a string past the lookback";
    const otherCode = demo({ drop: () => ok({ status: 422, body: '{"code":"macro_content"}' }) });
    expect(await dropMisses(ORIGIN, one(padded), otherCode.io)).toEqual([
      `guest drop of ${padded}: body lacks "code":"bad_structure"`,
    ]);
  });

  it("ends the screen when the socket, the claim or the drop fails, and names the step", async () => {
    for (const [over, miss] of [
      [{ socket: "fail" }, "screen socket refused"],
      [{ claim: ok({ status: 429, body: "{}" }) }, "guest claim answered 429"],
      [
        {
          drop: () => {
            throw new Error("timed out");
          },
        },
        "timed out",
      ],
    ] as const) {
      const d = demo(over);
      expect(await dropMisses(ORIGIN, one("a clean PDF"), d.io)).toEqual([`guest drop of a clean PDF: ${miss}`]);
      expect(d.log.at(-1)).toBe("POST /api/screen/end Bearer ref1.secret");
      // A socket that never opened has nothing to close; one that did is closed whatever failed after it.
      expect(d.closed).toEqual("socket" in over ? [] : ["ref1.secret"]);
    }
  });

  it("a screen that could not be made has nothing to end; an end that fails is a miss", async () => {
    const none = demo({ create: ok({ status: 503, body: "{}" }) });
    expect(await dropMisses(ORIGIN, one("a clean PDF"), none.io)).toEqual([
      "guest drop of a clean PDF: screen create answered 503",
    ]);
    expect(none.log).toEqual(["POST /api/screens"]);
    const stuck = demo({ end: ok({ status: 500, body: "{}" }) });
    expect(await dropMisses(ORIGIN, one("a clean PDF"), stuck.io)).toEqual([
      "guest drop of a clean PDF: screen end answered 500",
    ]);
  });

  it("the drop bytes are the corpus fixtures: the JS one hides its JavaScript in a compressed stream", () => {
    const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
    const js = drop("a PDF with /JavaScript in an object stream").bytes;
    expect(text(js)).not.toContain("JavaScript");
    expect(text(drop("a clean PDF").bytes).startsWith("%PDF-")).toBe(true);
    const built = (list: typeof HOSTILE | typeof CLEAN, name: string) => list.find(([n]) => n === name)?.[1]();
    const forged = "forged marks in a string of an object stream dictionary";
    expect(js).toEqual(built(HOSTILE, "JS in an object stream"));
    expect(drop("a PDF with forged object marks in a string").bytes).toEqual(built(HOSTILE, forged));
    const padded = drop("a PDF with forged object marks in a string past the lookback").bytes;
    expect(padded).toEqual(built(HOSTILE, `${forged}, the string longer than the lookback`));
    expect(padded.length).toBeGreaterThan(4096);
    expect(drop("a clean PDF").bytes).toEqual(built(CLEAN, "LaTeX hyperref"));
  });
});
