// The open variant of the site (public/open/, ADR 0026): what only it says, and the rules that keep the two modes apart.
// The generic page rules (CSP, voice, Title Case, chrome) run over both variants in site-pages.test.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PILL_OUT as PILL_OUT } from "../../src/shared/account-pill.ts";
import { site } from "../../tools/build-pages.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");
const pagesIn = (dir: string): string[] =>
  (readdirSync(`${ROOT}${dir}`, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".html") && (dir === "public/open" || !f.startsWith("open/")))
    .sort();
const text = (html: string) =>
  html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/[a-z]+>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const between = (html: string, start: RegExp, end: string) => {
  const from = html.search(start);
  const to = html.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`missing ${start}`);
  return html.slice(from, to + end.length);
};

const open = read("public/open/index.html");
const preview = read("public/index.html");
const openPages = pagesIn("public/open");
const previewPages = pagesIn("public");

describe("the open landing", () => {
  it("the hero holds Try the Demo, then Present Live, then the hint to the waitlist block", () => {
    const hero = between(open, /<section class="hero"/, "</section>");
    const links = [...hero.matchAll(/<a class="([^"]+)" href="([^"]+)">([^<]*)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(links).toEqual([
      ["btn primary", "/demo", "Try the Demo"],
      ["btn secondary", "/s", "Present Live"],
      ["hint", "#waitlist", "Invite only for now. Join the waitlist "],
    ]);
  });

  it("the hero is 24 of its 40 words: h1 2, sub 10, buttons 5, hint 7", () => {
    const hero = text(between(open, /<section class="hero"/, "</section>"));
    expect(hero.split(" ")).toHaveLength(24);
  });

  it("has no Features grid and no link to one", () => {
    expect(open).not.toContain('id="features"');
    expect(open).not.toContain("/#features");
    expect(open).not.toContain('class="cell"');
  });

  it("ends with the waitlist block: a heading that labels it, one line, Join the Waitlist, then Try the Demo", () => {
    const block = between(open, /<section class="close" id="waitlist"/, "</section>");
    expect(block).toContain('aria-labelledby="waitlist-h"');
    expect(block).toContain('<h2 id="waitlist-h">Join the Waitlist</h2>');
    expect(text(block)).toContain("bloop is invite only during early access. Join the waitlist to get an invite.");
    const actions = [...block.matchAll(/<a class="(btn [a-z]+)" href="([^"]+)"([^>]*)>([^<]*)/g)].map((m) => [
      m[1],
      m[2],
      m[4],
    ]);
    expect(actions).toEqual([
      ["btn primary", `${site.waitlist}?source=landing-end`, "Join the Waitlist"],
      ["btn secondary", "/demo", "Try the Demo"],
    ]);
    expect(block).toMatch(/<a class="btn primary"[^>]* data-waitlist>/);
    expect(open.indexOf('class="faq"')).toBeLessThan(open.indexOf('id="waitlist"'));
  });

  it("lists what bloop shows, once each, and the FAQ answer says the same", () => {
    const rows = [...between(open, /<h3 id="share-h">/, "</ul>").matchAll(/<\/svg>([^<]+)<\/li>/g)].map((m) => m[1]);
    expect(rows).toEqual(["Slides", "Documents", "PDFs", "Spreadsheets", "Photos", "Videos", "Links"]);
    expect(open).toContain("<p>Slides, documents, PDFs, spreadsheets, photos, videos and links.</p>");
  });

  it("open formats are a subset of Security's Live rows (claim 21: trim at the flip to what has shipped)", () => {
    const security = read("public/open/security.html");
    const live = [...between(security, /<section id="status"/, "</section>").matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((m) => m[1] ?? "")
      .filter((row) => row.includes('<span class="status on">Live</span>'))
      .map(text)
      .join(" ")
      .toLowerCase();
    const keyword: Record<string, string> = {
      slides: "powerpoint",
      documents: "word",
      pdfs: "pdf",
      spreadsheets: "excel",
      photos: "photos",
      videos: "videos",
    };
    const listed = [...between(open, /<h3 id="share-h">/, "</ul>").matchAll(/<\/svg>([^<]+)<\/li>/g)]
      .map((m) => (m[1] ?? "").toLowerCase())
      .filter((kind) => kind !== "links");
    expect(listed.length).toBe(Object.keys(keyword).length);
    for (const kind of listed) expect(live, kind).toContain(keyword[kind]);
    const features = text(read("public/open/articles/features.html")).toLowerCase();
    for (const kind of ["slides", "documents", "pdfs", "spreadsheets", "photos", "videos"]) {
      expect(features, kind).toContain(kind);
    }
  });
});

describe("the account pill and the open nav", () => {
  it.each(openPages)("MODE-01 public/open/%s carries the pill exactly as the Worker rewrites it", (rel) => {
    const html = read(`public/open/${rel}`);
    expect(html.split(PILL_OUT)).toHaveLength(2);
    expect(html.match(/data-account/g)).toHaveLength(1);
    // Exactly one label is hidden from assistive technology, so the accessible name is the visible label only.
    expect(PILL_OUT.match(/aria-hidden/g)).toHaveLength(1);
  });

  it("the nav holds Articles, Privacy and Terms, then the pill, and no Waitlist or Features", () => {
    const nav = between(open, /<header class="nav">/, "</header>");
    expect([...nav.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/articles", "/privacy", "/terms"]);
    expect(nav).not.toContain("data-waitlist");
    expect(nav).not.toContain("Features");
  });

  it("the footer adds Security, Accessibility and Report a File, then Waitlist and the address", () => {
    const footer = between(open, /<ul class="footer-links">/, "</ul>");
    expect([...footer.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)/g)].map((m) => [m[1], m[2]])).toEqual([
      ["/articles", "Articles"],
      ["/privacy", "Privacy"],
      ["/terms", "Terms"],
      ["/security", "Security"],
      ["/accessibility", "Accessibility"],
      ["/report", "Report a File"],
      [`${site.waitlist}?source=landing`, "Waitlist"],
      [`mailto:${site.email}`, site.email],
    ]);
  });
});

describe("MODE-01 preview shows nothing of the open site", () => {
  it.each(previewPages)("public/%s carries no pill and links no open-only or account path", (rel) => {
    const html = read(`public/${rel}`);
    expect(html).not.toContain("data-account");
    expect(html).not.toMatch(/href="\/(signin|library|account|admin|invite|report|articles\/features)[/"#?]/);
    expect(html).not.toContain("tools/pages/open");
  });

  it("the preview sitemap, llms.txt and Articles index name no open-only page", () => {
    for (const file of ["sitemap.xml", "llms.txt", "articles.html"]) {
      expect(read(`public/${file}`), file).not.toContain("/articles/features");
    }
    expect(read("public/open/sitemap.xml")).toContain("<loc>https://bloop.here/articles/features</loc>");
  });

  it("the open Articles index lists Features first and Security, preview's lists neither", () => {
    const heads = (html: string) =>
      [...html.matchAll(/<section id="[^"]+" aria-labelledby="[^"]+-h">\s*<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    const openHeads = heads(read("public/open/articles.html"));
    expect(openHeads[0]).toBe("Features");
    expect(openHeads).toContain("Security");
    const previewHeads = heads(read("public/articles.html"));
    expect(previewHeads).not.toContain("Features");
    expect(previewHeads).not.toContain("Security");
  });

  it("the preview landing keeps its one hero button and its Features grid", () => {
    const hero = between(preview, /<section class="hero"/, "</section>");
    expect(hero.match(/<a class="btn/g)).toHaveLength(1);
    expect(preview).toContain('id="features"');
    expect(preview.match(/<li class="cell">/g)).toHaveLength(6);
  });
});

describe("the open legal pages and articles", () => {
  it("Security is an article in open: no panel, no effective date or version, a published date", () => {
    const html = read("public/open/security.html");
    expect(html).not.toContain('class="panel');
    expect(html).not.toMatch(/Effective <time|· Version /);
    expect(html).toMatch(/<p class="meta">Published <time datetime="2026-11-25">/);
    expect(html).toContain('id="status"');
    expect(html).toContain('id="report"');
  });

  it("Privacy and Terms are C's drafts: numbered, with Privacy's panel kept", () => {
    expect(read("public/open/privacy.html")).toContain('class="panel');
    for (const page of ["privacy", "terms"]) expect(read(`public/open/${page}.html`)).toContain('class="clause"');
  });

  it("open Privacy names the three cookies the code uses", () => {
    const privacy = read("public/open/privacy.html");
    for (const cookie of ["__Host-bloop_sid", "__Host-bloop_in", "__Host-bloop_bind"])
      expect(privacy).toContain(cookie);
  });

  it.each(["public/privacy.html", "public/open/privacy.html"])("%s links to Security", (rel) => {
    expect(read(rel)).toContain('href="/security');
  });

  it("the open retention article links Privacy's table instead of restating it", () => {
    const html = read("public/open/articles/data-and-retention.html");
    expect(html).toContain('href="/privacy#retention"');
    expect(html).not.toMatch(/<th scope="col">Retention<\/th>/);
  });
});

describe("every internal link resolves within its variant", () => {
  // Pages outside the build: served by the Worker or the asset layer in both modes.
  const outside = (path: string) =>
    ["/demo", "/s", "/a", "/code", "/signin", "/library", "/report", "/it"].includes(path) ||
    path.startsWith("/.well-known/") ||
    existsSync(`${ROOT}public${path}`);

  for (const [name, dir, files] of [
    ["preview", "public", previewPages],
    ["open", "public/open", openPages],
  ] as const) {
    it(`${name}: each href names a page and an id that exist`, () => {
      const pages = new Map(
        files.map((f) => [
          `/${f.replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "")}`.replace(/^\/$/, "/"),
          read(`${dir}/${f}`),
        ]),
      );
      for (const [path, html] of pages) {
        for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
          const [target = "", id] = (m[1] ?? "").split("#");
          const dest = pages.get(target === "" ? "/" : target);
          if (dest === undefined) expect(outside(target), `${name} ${path}: ${m[1]}`).toBe(true);
          else if (id) expect(dest, `${name} ${path}: ${m[1]}`).toContain(`id="${id}"`);
        }
      }
    });
  }
});
