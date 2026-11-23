import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const SITE = ["index.html", "it.html", "privacy.html", "404.html"] as const;
const ALL = [...SITE, "s.html", "a.html", "code.html"] as const;
const VOID = new Set(["meta", "link", "img", "source", "input", "br", "hr", "wbr"]);
const SKIP_TAGS = new Set(["head", "script", "style", "svg", "noscript", "template"]);

/**
 * Visible words as a desktop visitor sees them: drops aria-hidden subtrees (the product UI mocks),
 * visually hidden text (.sr, the skip link), touch-only controls, and non-text elements.
 */
function visibleText(html: string, { touch = false } = {}): string {
  const hiddenClass = touch ? /\b(sr|skip|desk)\b/ : /\b(sr|skip|touch)\b/;
  const out: string[] = [];
  let skipDepth = 0;
  const stack: boolean[] = [];
  let last = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g)) {
    if (skipDepth === 0) out.push(html.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const [, close, rawTag, attrs = "", selfClose] = m;
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (close) {
      if (VOID.has(tag)) continue;
      const skipped = stack.pop();
      if (skipped) skipDepth -= 1;
      continue;
    }
    if (VOID.has(tag) || selfClose) continue;
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const skip =
      SKIP_TAGS.has(tag) || /aria-hidden="true"/.test(attrs) || hiddenClass.test(cls) || /\shidden(\s|$|=)/.test(attrs);
    stack.push(skip);
    if (skip) skipDepth += 1;
    out.push(" ");
  }
  out.push(html.slice(last));
  return out
    .join(" ")
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const between = (html: string, start: RegExp, end: string) => {
  const from = html.search(start);
  const to = html.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`missing ${start}`);
  return html.slice(from, to + end.length);
};

describe.each(SITE)("%s under the strict CSP", (page) => {
  const html = read(`public/${page}`);

  it("has no inline script, inline style, style attribute or event handler", () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("loads only same-origin scripts, styles and images", () => {
    for (const m of html.matchAll(/<(?:script|link|img|source)\b[^>]*?(?:src|href|srcset)="([^"]+)"/g)) {
      expect((m[1] as string).startsWith("http"), m[1]).toBe(false);
    }
  });

  it("is US English, light only, with a skip link first and one h1", () => {
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain('name="color-scheme" content="light"');
    expect(html).toMatch(/<body[^>]*>\s*<a class="skip"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it("preloads the one font subset, never the full file", () => {
    expect(html).toContain(
      '<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>',
    );
    expect(html).not.toContain("InterVariable");
  });

  it("uses absolute asset paths, since the 404 page is served at any depth", () => {
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1] as string;
      if (/^(#|mailto:|https:)/.test(url)) continue;
      expect(url.startsWith("/"), url).toBe(true);
    }
  });

  it("every heading is at most 8 words", () => {
    for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
      const text = visibleText(m[2] as string);
      expect(words(text).length, text).toBeLessThanOrEqual(8);
    }
  });
});

describe("every page's text", () => {
  const never = read("tools/never-say.txt")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const sources = [
    ...ALL.map((p) => [p, read(`public/${p}`)] as const),
    ["core/copy.js", read("public/js/core/copy.js")] as const,
    ["site.js", read("public/js/site.js")] as const,
    ["core/share.js", read("public/js/core/share.js")] as const,
  ];

  it.each(sources)("%s has no never-say phrase", (_name, text) => {
    const lower = text.toLowerCase();
    for (const phrase of never) expect(lower, phrase).not.toContain(phrase);
  });

  it.each(sources)("%s has no em or en dash and no exclamation mark in its text", (_name, text) => {
    const plain = text.replace(/<[^>]+>/g, " ");
    expect(plain).not.toMatch(/[–—]/);
    if (_name.endsWith(".html")) expect(plain).not.toMatch(/!/);
  });

  it.each(SITE)("%s keeps session, token and tenant off the page unless it is /it", (page) => {
    if (page === "it.html") return;
    const text = visibleText(read(`public/${page}`)).toLowerCase();
    expect(text).not.toMatch(/\b(session|token|tenant)s?\b/);
  });

  it.each(ALL)("%s uses only characters inside the font subset", (page) => {
    // The @font-face unicode-range in app.css and tools/subset-font.py.
    const ranges: [number, number][] = [
      [0x0000, 0x00ff],
      [0x0131, 0x0131],
      [0x0152, 0x0153],
      [0x02bb, 0x02bc],
      [0x02c6, 0x02c6],
      [0x02da, 0x02da],
      [0x02dc, 0x02dc],
      [0x2000, 0x206f],
      [0x2074, 0x2074],
      [0x20ac, 0x20ac],
      [0x2122, 0x2122],
      [0x2191, 0x2191],
      [0x2193, 0x2193],
      [0x2212, 0x2212],
      [0x2215, 0x2215],
      [0xfeff, 0xfeff],
      [0xfffd, 0xfffd],
    ];
    for (const ch of visibleText(read(`public/${page}`))) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(
        ranges.some(([lo, hi]) => cp >= lo && cp <= hi),
        `U+${cp.toString(16)}`,
      ).toBe(true);
    }
  });

  it("the CSS @font-face range is the subset script's range", () => {
    const css = read("public/css/app.css");
    const py = read("tools/subset-font.py");
    const range = /unicode-range:\s*([^;]+);/.exec(css)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const list = range.split(",").map((r) => r.trim());
    for (const r of list) expect(py, r).toContain(r);
    expect(css).toContain('url("/fonts/inter-latin.woff2")');
  });
});

describe("landing word caps (design.md section 13)", () => {
  const html = read("public/index.html");

  it("hero viewport, nav included: at most 40 words on desktop and on touch", () => {
    for (const touch of [false, true]) {
      // The nav CTA is visibility:hidden while the hero actions are in view (e2e checks that), so it is
      // not part of the hero viewport; the links count, as on the widest touch tier.
      const header = between(html, /<header class="nav-wrap">/, "</header>");
      expect(header).toContain('<div class="nav-cta is-hidden" id="nav-cta">');
      const nav = visibleText(header.replace(/<div class="nav-cta[\s\S]*?<\/div>/, ""), { touch });
      const hero = visibleText(between(html, /<section class="hero"/, "</section>"), { touch });
      const count = words(`${nav} ${hero}`).length;
      expect(count, `${touch ? "touch" : "desktop"}: ${nav} | ${hero}`).toBeLessThanOrEqual(40);
    }
  });

  it("h1 is two beats of at most 6 words, each ending with a period", () => {
    const h1 = visibleText(between(html, /<h1\b/, "</h1>"));
    expect(words(h1).length).toBeLessThanOrEqual(6);
    expect(html).toMatch(/<span class="beat">[^<]+\.<\/span> <span class="beat">[^<]+\.<\/span>/);
  });

  it("the sub names phone, screen and file in at most 2 sentences and 30 words", () => {
    const sub = visibleText(between(html, /<p class="lead">/, "</p>"));
    expect(words(sub).length).toBeLessThanOrEqual(30);
    for (const noun of ["phone", "screen", "file"]) expect(sub).toContain(noun);
    expect(sub.match(/[.]/g)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("the whole landing is 150 to 250 words outside product UI", () => {
    const count = words(visibleText(html)).length;
    expect(count).toBeGreaterThanOrEqual(150);
    expect(count).toBeLessThanOrEqual(250);
  });

  it("each section sentence outside product UI is at most 20 words", () => {
    const text = visibleText(between(html, /<main id="main">/, "</main>"));
    for (const sentence of text.split(/(?<=[.?])\s+/)) {
      expect(words(sentence).length, sentence).toBeLessThanOrEqual(20);
    }
  });

  it("the product UI mocks are hidden from assistive tech and inert", () => {
    const mocks = [...html.matchAll(/<div class="(?:phone|mock-screen)(?: [^"]*)?"([^>]*)>/g)];
    expect(mocks.length).toBeGreaterThanOrEqual(6);
    for (const m of mocks) {
      expect(m[1]).toContain('aria-hidden="true"');
      expect(m[1]).toContain("inert");
    }
  });

  it("the robin's orange never appears in CSS", () => {
    expect(read("public/css/app.css").toLowerCase()).not.toContain("ff7702");
  });

  it("the poster is the LCP image: preloaded, high priority, never lazy, sized", () => {
    expect(html).toMatch(/<link rel="preload" as="image" type="image\/avif" imagesrcset="\/img\/robin-perch-640\.avif/);
    const poster = /<img class="poster" src="\/img\/robin-perch[^>]+>/.exec(html)?.[0] ?? "";
    expect(poster).toContain('fetchpriority="high"');
    expect(poster).toContain('width="560" height="560"');
    expect(poster).toContain('alt=""');
    expect(poster).not.toContain("loading=");
  });
});

describe("site scripts under the strict CSP", () => {
  it.each([
    "landing.js",
    "site.js",
    "page.js",
    "robin.js",
    "core/robin-pose.js",
    "core/robin-math.js",
    "core/share.js",
  ])("%s never uses eval, HTML sinks, inline styles or script URLs", (file) => {
    const code = read(`public/js/${file}`);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/new Function\s*\(/);
    expect(code).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/setTimeout\(\s*["'`]/);
    expect(code).not.toMatch(/\.style\.|setAttribute\(\s*["']style/);
  });

  it("the landing never fetches the renderer before the load event", () => {
    const code = read("public/js/landing.js");
    expect(code).not.toMatch(/^import .*robin\.js/m);
    expect(code).toMatch(/addEventListener\("load"/);
    expect(code).not.toMatch(/addEventListener\("scroll"/);
  });
});
