import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_HEADERS,
  CSP,
  DYNAMIC_PAGES,
  headersFor,
  type Policy,
  pageCsp,
  permissionsPolicy,
  withHeaders,
  withSources,
} from "../../src/worker/headers.ts";
import { VARIANTS } from "../../src/worker/page-registry.ts";
import { staticHeaders as resolve } from "../../tools/static-headers.mjs";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const HEADERS_FILE = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
const VARS = wranglerConfig(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")).vars;
const SITE_HOST = new URL(VARS.PUBLIC_ORIGIN).host;
const staticHeaders = (path: string, host = SITE_HOST): Record<string, string> => resolve(HEADERS_FILE, path, host);

const lower = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

const pages: [string, Policy][] = [
  ["/", "landing"],
  ["/s", "screen"],
  ["/a", "app"],
  ["/code", "app"],
  ["/signin", "auth"],
  ["/invite", "auth"],
  ["/account", "auth"],
  ["/admin", "auth"],
  ["/report", "report"],
  ["/library", "library"],
  ["/security", "landing"],
  ["/privacy", "landing"],
  ["/terms", "landing"],
  ["/.well-known/security.txt", "landing"],
  ["/anything-else", "landing"],
];

describe("public/_headers matches headers.ts", () => {
  for (const [path, policy] of pages) {
    it(`${path} gets the ${policy} policy`, () => {
      expect(staticHeaders(path)).toEqual(lower(headersFor(policy)));
    });
  }

  it("MODE-01 headers: every page variant under /open/ answers its base page's headers", () => {
    for (const path of [...VARIANTS.map((v) => v.path), "/privacy", "/terms"]) {
      expect(staticHeaders(`/open${path}`)).toEqual(staticHeaders(path));
    }
  });

  it("MODE-01 headers: the report page keeps Turnstile and has no passkey permissions", () => {
    const policy = staticHeaders("/report")["permissions-policy"] ?? "";
    expect(policy).not.toContain("publickey-credentials-get=(self)");
    expect(staticHeaders("/report")["content-security-policy"]).toContain("challenges.cloudflare.com");
  });
});

describe("caching and worker policy in _headers", () => {
  const immutable = "public, max-age=31536000, immutable";
  const files = (dir: string): string[] =>
    (existsSync(new URL(`../../public/${dir}`, import.meta.url))
      ? readdirSync(new URL(`../../public/${dir}`, import.meta.url), { recursive: true, withFileTypes: true })
      : []
    )
      .filter((d) => d.isFile())
      .map(
        (d) =>
          `/${dir}/${relative(new URL(`../../public/${dir}`, import.meta.url).pathname, join(d.parentPath, d.name))}`,
      );

  it("every file under /fonts and /js/vendor, and in a folder of /js/workers, is immutable and has a content hash in its name", () => {
    const all = [
      ...files("fonts"),
      ...files("js/vendor"),
      ...files("js/workers").filter((p) => /^\/js\/workers\/[^/]+\//.test(p)),
    ];
    expect(all.length).toBeGreaterThan(2);
    for (const path of all) {
      expect(staticHeaders(path)["cache-control"], path).toBe(immutable);
      expect(path, path).toMatch(/-[0-9a-f]{8}(\.|\/)/);
    }
  });

  it("a script directly in /js/workers is not immutable", () => {
    expect(staticHeaders("/js/workers/sheet.js")["cache-control"]).toBeUndefined();
  });

  it("pages, scripts and styles carry no Cache-Control or Vary here, so the asset layer revalidates them with an ETag", () => {
    for (const path of ["/", "/s", "/js/site.js", "/css/base.css", "/favicon.svg"]) {
      expect(staticHeaders(path)["cache-control"], path).toBeUndefined();
      expect(staticHeaders(path).vary, path).toBeUndefined();
    }
  });

  it("a revalidated read is private and no-cache, never no-store", () => {
    expect(headersFor("api-revalidate")["Cache-Control"]).toBe("private, no-cache");
    expect(headersFor("api")["Cache-Control"]).toBe("no-store");
  });

  it("an image with a hash in its name is immutable, any other is revalidated", () => {
    expect(staticHeaders("/img/hero.3fa9c21b.avif")["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(staticHeaders("/img/hero.avif")["cache-control"]).toBe("no-cache");
  });

  it("a static 404 on the file origin carries the file origin's sandbox CSP, and the site's host does not", () => {
    const fileHost = new URL(VARS.FILE_ORIGIN).host;
    expect(staticHeaders("/js/no-such.js", fileHost)["content-security-policy"]).toBe(
      headersFor("file-origin")["Content-Security-Policy"],
    );
    expect(staticHeaders("/js/no-such.js")["content-security-policy"]).not.toContain("sandbox");
  });

  it("a viewer worker script is a no-network policy and keeps every base header", () => {
    expect(staticHeaders("/js/workers/sheet.js")).toEqual(lower(headersFor("worker")));
    // A hashed folder of workers is also immutable, which the worker policy does not say.
    const { "cache-control": cache, ...hashed } = staticHeaders("/js/workers/pdf-1a2b3c4d/pdf.worker.min.mjs");
    expect(cache).toBe("public, max-age=31536000, immutable");
    expect(hashed).toEqual(lower(headersFor("worker")));
    expect(CSP.worker).toBe("default-src 'none'; script-src 'self'");
  });
});

describe("dynamic sources: the file origin and the R2 EU endpoint are added at serve time", () => {
  const file = "https://files.example";
  const r2 = "https://acct.eu.r2.cloudflarestorage.com";

  it("the screen page gains the file origin in img, media and connect, and nothing else", () => {
    const csp = pageCsp("/s", { fileOrigin: file, r2Endpoint: r2 }) as string;
    expect(csp).toContain(`img-src 'self' ${file};`);
    expect(csp).toContain(`media-src 'self' ${file};`);
    expect(csp).toContain(`connect-src 'self' ${file};`);
    expect(csp).not.toContain(r2);
    expect(csp.replaceAll(` ${file}`, "")).toBe(CSP.screen);
  });

  it("the phone page gains only the exact R2 endpoint, in connect-src", () => {
    const csp = pageCsp("/a", { fileOrigin: file, r2Endpoint: r2 }) as string;
    expect(csp).toContain(`connect-src 'self' ${r2};`);
    expect(csp).not.toContain(file);
    expect(csp.replace(` ${r2}`, "")).toBe(CSP.app);
  });

  it("the library page gains both; with neither configured every page keeps its static policy", () => {
    const csp = pageCsp("/library", { fileOrigin: file, r2Endpoint: r2 }) as string;
    expect(csp).toContain(`connect-src 'self' ${file} ${r2};`);
    for (const page of Object.keys(DYNAMIC_PAGES)) {
      expect(pageCsp(page, { fileOrigin: null, r2Endpoint: null })).toBe(CSP[DYNAMIC_PAGES[page]?.policy as Policy]);
    }
    expect(pageCsp("/privacy", { fileOrigin: file, r2Endpoint: r2 })).toBeNull();
  });

  it("withSources adds a missing directive after default-src and leaves an empty list alone", () => {
    expect(withSources("default-src 'none'; img-src 'self'", "media-src", ["https://x"])).toBe(
      "default-src 'none'; media-src https://x; img-src 'self'",
    );
    expect(withSources("default-src 'none'", "connect-src", [])).toBe("default-src 'none'");
  });
});

describe("headers.ts", () => {
  const POLICIES = Object.keys(CSP) as Policy[];

  it("every policy carries the base headers", () => {
    for (const policy of POLICIES) {
      // Permissions-Policy varies by page kind (screen, wake, auth); every other base header is shared.
      // The file-origin ping is read cross-origin, so its CORP is cross-origin.
      const { "Permissions-Policy": _own, "Cross-Origin-Resource-Policy": corp, ...shared } = BASE_HEADERS;
      expect(headersFor(policy)).toMatchObject(shared);
      expect(headersFor(policy)["Cross-Origin-Resource-Policy"]).toBe(policy === "file-origin" ? "cross-origin" : corp);
      const kinds: Partial<Record<Policy, Parameters<typeof permissionsPolicy>[0]>> = {
        screen: "screen",
        app: "wake",
        library: "wake",
        auth: "auth",
      };
      expect(headersFor(policy)["Permissions-Policy"]).toBe(permissionsPolicy(kinds[policy] ?? "none"));
    }
  });

  it("SITE-08 headers: HSTS for two years on every policy, subdomains included", () => {
    for (const policy of POLICIES) {
      expect(headersFor(policy)["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    }
    expect(CSP.app).toContain("upgrade-insecure-requests");
  });

  it("OPEN-05 headers: no Referer on any response", () => {
    for (const policy of POLICIES) {
      expect(headersFor(policy)["Referrer-Policy"]).toBe("no-referrer");
    }
  });

  it("SITE-02 csp: pages allow no inline or eval script and no Trusted Types policy", () => {
    for (const policy of ["landing", "app"] as const) {
      expect(CSP[policy]).toContain("script-src 'self';");
      expect(CSP[policy]).not.toMatch(/unsafe-(inline|eval)/);
      expect(CSP[policy]).toContain("require-trusted-types-for 'script'");
      expect(CSP[policy]).toContain("trusted-types 'none'");
    }
  });

  it("SITE-02 csp: the landing policy allows no connection and no manifest, the app pages only their own origin", () => {
    expect(CSP.landing).not.toMatch(/connect-src|manifest-src/);
    expect(CSP.app).toContain("connect-src 'self'");
  });

  it("api and file responses are never cached", () => {
    for (const policy of ["api", "file-pptx", "file-pdf", "file-image"] as const) {
      expect(headersFor(policy)["Cache-Control"]).toBe("no-store");
    }
  });

  it("PREVIEW-01 thumb policy: the handler's Cache-Control survives, the page policies are never widened", () => {
    expect(headersFor("thumb")["Cache-Control"]).toBeUndefined();
    expect(CSP.thumb).toBe(CSP.api);
    const kept = withHeaders(new Response("x", { headers: { "Cache-Control": "public, max-age=86400" } }), "thumb");
    expect(kept.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(kept.headers.get("X-Content-Type-Options")).toBe("nosniff");
    for (const policy of ["landing", "app", "screen", "library"] as const) {
      expect(CSP[policy]).toContain("img-src 'self'");
      expect(CSP[policy]).not.toMatch(/img-src[^;]*(ytimg|youtube|https:)/);
    }
  });

  it("withHeaders overrides what a handler set and keeps status and body", async () => {
    const res = withHeaders(new Response("x", { status: 418, headers: { "X-Frame-Options": "SAMEORIGIN" } }), "api");
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("x");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
