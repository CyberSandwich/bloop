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
  const main = between(html, /<main id="main">/, "</main>");

  it("the hero is at most 40 words: h1, sub and the two buttons", () => {
    const hero = visibleText(between(html, /<section class="hero"/, "</section>"));
    expect(words(hero).length, hero).toBeLessThanOrEqual(40);
  });

  it("h1 is one sentence of at most 6 words, one line, no second clause", () => {
    const h1 = visibleText(between(html, /<h1\b/, "</h1>"));
    expect(words(h1).length).toBeLessThanOrEqual(6);
    expect(h1).toMatch(/^[^.]+\.$/);
    expect(between(html, /<h1\b/, "</h1>")).not.toMatch(/<span/);
  });

  it("the sub names phone, screen and file in at most 2 sentences and 30 words", () => {
    const sub = visibleText(between(html, /<p class="lead">/, "</p>"));
    expect(words(sub).length).toBeLessThanOrEqual(30);
    for (const noun of ["phone", "screen", "file"]) expect(sub).toContain(noun);
    expect(sub.match(/[.]/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("the whole landing is 80 to 180 words outside product UI, open answers included", () => {
    const count = words(visibleText(html)).length;
    expect(count).toBeGreaterThanOrEqual(80);
    expect(count).toBeLessThanOrEqual(180);
  });

  it("each sentence outside product UI is at most 20 words", () => {
    for (const sentence of visibleText(main).split(/(?<=[.?])\s+/)) {
      expect(words(sentence).length, sentence).toBeLessThanOrEqual(20);
    }
  });

  it("Try the demo opens the demo screen; early access is a mail to the role address", () => {
    const actions = between(html, /<div class="hero-actions"/, "</div>");
    expect(actions).toMatch(/<a class="btn primary" href="\/s\?mode=demo">Try the demo<\/a>/);
    expect(actions).toMatch(
      /<a class="btn secondary" href="mailto:ventures@saputra\.co\.uk\?subject=[^"]+">Get early access<\/a>/,
    );
  });

  it("the FAQ is at most 4 native details, and the residue answer links to /it without a nothing-stays claim", () => {
    const faq = between(html, /<section class="faq"/, "</section>");
    const items = [...faq.matchAll(/<details>\s*<summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(4);
    const residue = items.find((m) => /room PC keep/.test(m[1] ?? ""))?.[2] ?? "";
    expect(residue).toContain('href="/it"');
    expect(residue).toMatch(/can stay/);
    expect(residue.toLowerCase()).not.toMatch(/nothing (is )?left|leaves nothing/);
  });

  it("the reel is one labeled image; its frames are hidden from assistive tech and inert", () => {
    expect(html).toMatch(/<div class="reel-stage" role="img" aria-label="[^"]{40,}">/);
    expect(html).toMatch(/<ol class="frames" aria-hidden="true" inert>/);
    expect(html).toMatch(/<button class="reel-toggle"[^>]*aria-pressed="false"[^>]*hidden>/);
  });

  it("the bottom pill is a plain div, inert until the script shows it, and there is no nav landmark", () => {
    expect(html).toMatch(/<div class="pill" id="pill" inert>/);
    expect(html).not.toMatch(/<nav\b/);
  });

  it("og:image and og:url are absolute, for link previews", () => {
    expect(html).toContain('<meta property="og:image" content="https://bloop.dsap.workers.dev/og.png">');
    expect(html).toContain('<meta property="og:url" content="https://bloop.dsap.workers.dev/">');
  });

  it("the logo's colors stay in the logo: never in CSS", () => {
    const css = read("public/css/app.css").toLowerCase();
    for (const hex of ["f4ba8b", "646464", "ff7702"]) expect(css).not.toContain(hex);
  });

  it.each(ALL)("%s has no robin", (page) => {
    expect(read(`public/${page}`).toLowerCase()).not.toContain("robin");
  });
});

describe("site scripts under the strict CSP", () => {
  it.each(["site.js"])("%s never uses eval, HTML sinks, inline styles or script URLs", (file) => {
    const code = read(`public/js/${file}`);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/new Function\s*\(/);
    expect(code).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/setTimeout\(\s*["'`]/);
    expect(code).not.toMatch(/\.style\.|setAttribute\(\s*["']style/);
  });

  it("the landing script imports nothing and listens to no scroll event", () => {
    const code = read("public/js/site.js");
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/addEventListener\("scroll"/);
  });

  it("every site page loads only the landing script, or none", () => {
    for (const page of SITE) {
      const scripts = [...read(`public/${page}`).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
      expect(scripts, page).toEqual(page === "index.html" ? ["/js/site.js"] : []);
    }
  });
});
