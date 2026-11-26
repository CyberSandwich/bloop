// MODE-01 against a real wrangler dev: the site pages by launch mode, the account pill, and the revalidation rules.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startPairing({}, { migrate: true });
});
afterAll(async () => {
  await wrangler?.stop();
});

const HTML = { Accept: "text/html" };
const IN = { Cookie: "__Host-bloop_in=1" };
const hit = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${wrangler.url}${path}`, { redirect: "manual", headers });
const label = (html: string) => (html.includes("<span>Library</span>") ? "Library" : "Sign In");

describe("MODE-01 landing and legal bodies differ by mode", () => {
  it("preview is today's landing: one Waitlist pill, one hero button, a Features grid", async () => {
    wrangler.setLaunchMode("preview");
    const html = await (await hit("/")).text();
    expect(html).toContain('<a class="btn waitlist"');
    expect(html).toContain('id="features"');
    expect(html).not.toContain("Present Live");
    expect(html).not.toContain("data-account");
  });

  it("open is the open landing: the account pill, two hero buttons, the hint and the waitlist block", async () => {
    wrangler.setLaunchMode("open");
    const html = await (await hit("/")).text();
    expect(html).toContain("data-account");
    expect(html).toContain("Present Live");
    expect(html).toContain('href="#waitlist"');
    expect(html).toContain('id="waitlist"');
    expect(html).not.toContain('id="features"');
    expect(html).not.toContain('<a class="btn waitlist"');
  });

  it("each legal page and article is a different body in each mode, and Features is open only", async () => {
    const paths = ["/privacy", "/terms", "/security", "/articles", "/articles/how-bloop-works", "/sitemap.xml"];
    const bodies = async (mode: "preview" | "open") => {
      wrangler.setLaunchMode(mode);
      return Promise.all(paths.map(async (path) => (await hit(path)).text()));
    };
    const preview = await bodies("preview");
    const open = await bodies("open");
    paths.forEach((path, i) => {
      expect(open[i], path).not.toBe(preview[i]);
    });
    wrangler.setLaunchMode("preview");
    expect((await hit("/articles/features")).status).toBe(404);
    expect(await (await hit("/sitemap.xml")).text()).not.toContain("/articles/features");
    wrangler.setLaunchMode("open");
    expect((await hit("/articles/features")).status).toBe(200);
    expect(await (await hit("/sitemap.xml")).text()).toContain("/articles/features");
  });

  it("MODE-01 no variant fetch redirects: / in open is 200 with no Location, and no /open form answers", async () => {
    wrangler.setLaunchMode("open");
    const res = await hit("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    await res.arrayBuffer();
    for (const form of ["/open", "/open/", "/open/privacy", "/Open/privacy", "/%6Fpen/privacy"]) {
      expect((await hit(form)).status, form).toBe(404);
    }
  });

  it("MODE-01 in preview no /open form answers, a view cookie without a session changes nothing, and /404 is a 404", async () => {
    wrangler.setLaunchMode("preview");
    for (const form of ["/open", "/open/", "/open/privacy", "/Open/privacy", "/%6Fpen/privacy"]) {
      expect((await hit(form)).status, form).toBe(404);
    }
    const viewing = await hit("/", { Cookie: "__Host-bloop_view=open" });
    expect(await viewing.text()).not.toContain("data-account");
    for (const mode of ["preview", "open"] as const) {
      wrangler.setLaunchMode(mode);
      expect((await hit("/404", HTML)).status, mode).toBe(404);
    }
  });

  it("MODE-01 open 404 carries the open nav: an unknown page is 404 with Sign In in open, the Waitlist pill in preview", async () => {
    wrangler.setLaunchMode("open");
    const open = await hit("/no-such-page", HTML);
    expect(open.status).toBe(404);
    expect(await open.text()).toContain("data-account");
    wrangler.setLaunchMode("preview");
    const preview = await hit("/no-such-page", HTML);
    expect(preview.status).toBe(404);
    expect(await preview.text()).toContain('<a class="btn waitlist"');
  });

  it("/it is a 301 to /security and /security has its report section, in both modes", async () => {
    for (const mode of ["preview", "open"] as const) {
      wrangler.setLaunchMode(mode);
      const moved = await hit("/it");
      expect(moved.status, mode).toBe(301);
      expect(new URL(moved.headers.get("Location") ?? "", wrangler.url).pathname).toBe("/security");
      await moved.arrayBuffer();
      expect(await (await hit("/security")).text(), mode).toContain('id="report"');
    }
  });

  it("served HTML has no comment, in both modes", async () => {
    for (const mode of ["preview", "open"] as const) {
      wrangler.setLaunchMode(mode);
      for (const path of ["/", "/privacy", "/terms", "/security", "/articles", "/articles/how-bloop-works"]) {
        expect(await (await hit(path)).text(), `${mode} ${path}`).not.toContain("<!--");
      }
      expect(await (await hit("/no-such-page", HTML)).text(), `${mode} 404`).not.toContain("<!--");
    }
  });
});

describe("pill Library with the hint cookie; the 304 round trip keeps the label", () => {
  it("a visitor with the hint sees Library, the others Sign In, and the page varies by cookie", async () => {
    wrangler.setLaunchMode("open");
    const out = await hit("/privacy");
    const signedIn = await hit("/privacy", IN);
    expect(label(await out.text())).toBe("Sign In");
    expect(label(await signedIn.text())).toBe("Library");
    for (const res of [out, signedIn]) expect(res.headers.get("Vary") ?? "").toMatch(/\bCookie\b/);
    // The asset layer's own revalidation policy is kept: always revalidated, never stored as fresh.
    expect(out.headers.get("Cache-Control")).toMatch(/no-cache|max-age=0/);
  });

  it("each copy revalidates to a 304 for itself and to a full page for the other", async () => {
    wrangler.setLaunchMode("open");
    const out = await hit("/");
    const outTag = out.headers.get("ETag") ?? "";
    await out.arrayBuffer();
    expect(outTag).not.toBe("");
    const signedIn = await hit("/", { ...IN, "If-None-Match": outTag });
    expect(signedIn.status).toBe(200);
    expect(label(await signedIn.text())).toBe("Library");
    const inTag = signedIn.headers.get("ETag") ?? "";
    expect(inTag).not.toBe(outTag);
    expect((await hit("/", { ...IN, "If-None-Match": inTag })).status).toBe(304);
    const back = await hit("/", { "If-None-Match": inTag });
    expect(back.status).toBe(200);
    expect(label(await back.text())).toBe("Sign In");
    expect((await hit("/", { "If-None-Match": outTag })).status).toBe(304);
  });

  it("the open 404 shows Library to a visitor with the hint", async () => {
    wrangler.setLaunchMode("open");
    expect(label(await (await hit("/no-such-page", { ...HTML, ...IN })).text())).toBe("Library");
  });

  it("preview never varies or rewrites", async () => {
    wrangler.setLaunchMode("preview");
    const res = await hit("/", IN);
    expect(res.headers.get("Vary") ?? "").not.toMatch(/\bCookie\b/);
    expect(await res.text()).not.toContain("data-account");
  });
});
