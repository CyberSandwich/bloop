import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTENSION_TYPES } from "../../public/js/shared/names.js";
import { contrast, type Rgb, token } from "./contrast.ts";
import { NEVER_SAY } from "./never-say.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
// The articles are built from content/articles/ (design.md section 6, Site build): the index and one page each.
const ARTICLES = [
  "articles.html",
  ...readdirSync(fileURLToPath(new URL("../../content/articles", import.meta.url)))
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .map((f) => `articles/${f.replace(/\.md$/, ".html")}`),
];
// The contracts (design.md section 6, Legal pages).
const LEGAL = ["privacy.html", "terms.html", "security.html"] as const;
const SITE = ["index.html", ...LEGAL, "404.html", ...ARTICLES];
// Every doc page also loads legal.css and legal.js.
const isDoc = (page: string) => (LEGAL as readonly string[]).includes(page) || ARTICLES.includes(page);
const ALL = [...SITE, "s.html", "a.html", "code.html"];
const VOID = new Set(["meta", "link", "img", "source", "input", "br", "hr", "wbr"]);
const CSS_FILES = ["base.css", "site.css", "legal.css", "app.css"] as const;
const SKIP_TAGS = new Set(["head", "script", "style", "svg", "noscript", "template"]);
// Title Case (design.md section 3) keeps these lowercase after the first word.
const MINOR = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "as",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "with",
]);

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

const unnumbered = (heading: string) => heading.replace(/<a class="num"[^>]*>[^<]*<\/a>/g, "");
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
    // A JSON-LD block is data: the browser never runs it, so script-src and Trusted Types do not apply to it.
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]?.trim()).toBe('type="application/ld+json"');
      expect(() => JSON.parse(m[2] ?? "")).not.toThrow();
    }
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)(?![^>]*type="application\/ld\+json")/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("loads only same-origin scripts, styles and images", () => {
    for (const m of html.matchAll(/<(?:script|link|img|source)\b[^>]*?(?:src|href|srcset)="([^"]+)"/g)) {
      // The canonical link names the page itself; it fetches nothing.
      if (m[0].includes('rel="canonical"')) continue;
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

  it("every heading and label is at most 5 words", () => {
    const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => unnumbered(m[2] as string));
    const labels = [...html.matchAll(/<span class="status[^"]*">([^<]*)<\/span>/g)].map((m) => m[1] as string);
    for (const text of [...headings, ...labels].map((t) => visibleText(t))) {
      expect(words(text).length, text).toBeLessThanOrEqual(5);
    }
  });

  it("every heading and the title are Title Case with no period (design.md section 3)", () => {
    const titles = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) =>
      visibleText(unnumbered(m[2] as string)),
    );
    titles.push((/<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "").replace(/^bloop:? /, ""));
    for (const title of titles) {
      expect(title, title).not.toMatch(/[.]$/);
      words(title).forEach((word, i) => {
        if (word === "bloop" || (i > 0 && MINOR.has(word.replace(/,$/, "")))) return;
        expect(word[0], `${word} in "${title}"`).toBe(word[0]?.toUpperCase());
      });
    }
  });

  it("draws icons as Lucide: inline, 2 stroke, round caps, hidden from screen readers", () => {
    for (const m of html.matchAll(/<svg\b[^>]*>/g)) {
      expect(m[0]).toContain('stroke-width="2"');
      expect(m[0]).toContain('stroke-linecap="round"');
      expect(m[0]).toContain('aria-hidden="true"');
    }
  });

  it('sets "bloop" in body copy as the robin name', () => {
    // The legal line is a name in a notice, not copy; a mail domain or the site's host is an address.
    for (const m of html.matchAll(/<p(?! class="footer-legal")\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const bare = (m[1] as string)
        .replace(/<b class="name">bloop<\/b>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\S+@bloop\.\S+/g, "")
        .replace(/\bbloop\.here\b/g, "");
      expect(bare, m[1]).not.toMatch(/\bbloop\b/);
    }
  });
});

describe("every page's text", () => {
  const sources = [
    ...ALL.map((p) => [p, read(`public/${p}`)] as const),
    ...["copy", "copy-screen", "copy-phone", "copy-code"].map(
      (f) => [`core/${f}.js`, read(`public/js/core/${f}.js`)] as const,
    ),
    ["site.js", read("public/js/site.js")] as const,
    ["legal.js", read("public/js/legal.js")] as const,
  ];

  it.each(sources)("%s has no never-say phrase", (_name, text) => {
    const lower = text.toLowerCase();
    for (const phrase of NEVER_SAY) expect(lower, phrase).not.toContain(phrase);
  });

  it.each(sources)("%s has no em or en dash and no exclamation mark in its text", (_name, text) => {
    const plain = text.replace(/<[^>]+>/g, " ");
    expect(plain).not.toMatch(/[–—]/);
    if (_name.endsWith(".html")) expect(plain).not.toMatch(/!/);
  });

  // The doc pages define Session and name tokens and tenants where the law or IT needs them (design.md section 3).
  it.each(["index.html", "404.html"])("%s keeps session, token and tenant off the page", (page) => {
    const text = visibleText(read(`public/${page}`)).toLowerCase();
    expect(text).not.toMatch(/\b(session|token|tenant)s?\b/);
  });

  it.each(ALL)("%s uses only characters inside the font subset", (page) => {
    // The @font-face unicode-range in base.css and tools/subset-font.py.
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
    const css = read("public/css/base.css");
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

  it("the hero is at most 40 words: h1, sub and its one button", () => {
    const hero = visibleText(between(html, /<section class="hero"/, "</section>"));
    expect(words(hero).length, hero).toBeLessThanOrEqual(40);
  });

  it("h1 is Present Anywhere, one line, no second clause; only Anywhere carries the sheen", () => {
    const h1 = between(html, /<h1\b/, "</h1>");
    expect(visibleText(h1)).toBe("Present Anywhere");
    expect(h1).toContain('<span class="sheen">Anywhere</span>');
    expect(h1.match(/<span/g)).toHaveLength(1);
  });

  it("Anywhere is ink under a tiling orange band that sweeps without a seam, and never plays under reduced motion", () => {
    const css = read("public/css/site.css");
    expect(css).toMatch(
      /^\.sheen \{(?:\s*\/\*.*\*\/)?\s*margin-inline: -0\.05em;\s*padding-inline: 0\.05em;\s*color: var\(--ink\);\s*\}/m,
    );
    const block = between(css, /@supports \(background-clip: text\)/, "\n.lead {");
    const moving = between(block, /prefers-reduced-motion: no-preference\) \{/, "\n    }");
    expect(moving).toMatch(
      /background-clip: text;[^}]*color: transparent;[^}]*animation: sweep [\d.]+s linear [\d.]+s infinite backwards;/,
    );
    // The band is the only gradient; under it the fill is ink, so the word never rests as a gradient.
    expect(moving.match(/linear-gradient/g)).toHaveLength(1);
    expect(moving).toMatch(/var\(--robin\) \d+%/);
    // Transparent at both ends of the tile, so tiles meet in ink, and the keyframe moves exactly one tile.
    const stops = [...moving.matchAll(/(transparent|var\(--[a-z-]+\)) (\d+)%/g)];
    expect(stops[0]?.[1]).toBe("transparent");
    expect(stops.at(-1)?.[1]).toBe("transparent");
    expect(Number(stops.at(-1)?.[2])).toBeLessThan(100);
    const tile = /0 0 \/ ([\d.]+em) 100% repeat-x var\(--ink\);/.exec(moving)?.[1];
    expect(tile).toBeTruthy();
    expect(between(css, /@keyframes sweep \{/, "\n}\n")).toMatch(
      new RegExp(`to \\{\\s*background-position: ${tile?.replace(".", "\\.")} 0;\\s*\\}`),
    );
    expect(css).not.toMatch(/text-shadow/);
  });

  it("the why sits between the stills and Features, read once as the design.md sentence, its words as the fill's spans", () => {
    const why = between(html, /<section class="why" aria-label="Why bloop">/, "</section>");
    expect(main.indexOf('<section class="how"')).toBeLessThan(main.indexOf('<section class="why"'));
    expect(main.indexOf('<section class="why"')).toBeLessThan(main.indexOf('<section class="features"'));
    const sr = (/<span class="sr">(.+?)<\/span>/.exec(why)?.[1] ?? "").replace(/<[^>]+>/g, "");
    const row = /^\| Why \| (.+?) \(/m.exec(read("docs/design.md"))?.[1]?.replace(/\*\*/g, "") ?? "";
    expect(sr).toBe(row);
    for (const sentence of sr.split(/(?<=[.?])\s+/)) expect(words(sentence).length, sentence).toBeLessThanOrEqual(20);
    // The fill's copy is hidden from assistive tech and holds the same words, bloop as the name in body copy.
    const fill = between(why, /<span class="why-words" aria-hidden="true">/, "</p>");
    expect(
      fill
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe(sr);
    expect(fill).toContain('<b class="name">bloop</b>');
    expect(fill.match(/<span>/g)).toHaveLength(words(sr).length - 1);
  });

  it("the why fills word by word in reading order by a clipped gradient, never by opacity, and only with motion allowed", () => {
    const css = read("public/css/site.css");
    const block = between(
      css,
      /@supports \(animation-timeline: view\(\)\) \{\n {2}@media \(prefers-reduced-motion: no-preference\) and \(forced-colors: none\)/,
      "\n}\n",
    );
    expect(block).toMatch(/\.why-words > \* \{[^}]*background-clip: text;[^}]*-webkit-text-fill-color: transparent;/);
    // One progress for the paragraph; a word moves only inside its own slice (index --i of --n, from site.js).
    expect(block).toMatch(/\.why p \{\s*view-timeline: --why-view;/);
    expect(block).toMatch(
      /\.why-words \{\s*animation: why linear both;\s*animation-timeline: --why-view;\s*animation-range: cover 5% cover 50%;/,
    );
    expect(block).toMatch(
      /background-position-x: calc\(100% - 100% \* clamp\(0, var\(--why\) \* var\(--n\) - var\(--i\), 1\)\);/,
    );
    expect(css).toMatch(/@property --why \{\s*syntax: "<number>";\s*inherits: true;\s*initial-value: 0;/);
    expect(read("public/js/site.js")).toMatch(
      /w\.style\.setProperty\("--i", `\$\{i\}`\);\s*w\.style\.setProperty\("--n", `\$\{words\.length\}`\);/,
    );
    expect(block).not.toMatch(/opacity/);
    // Large text: the faint state holds 3:1 on paper, and the word's box is widened by its tracking so the clip
    // reaches its last glyph.
    const faint = Number(/color-mix\(in srgb, var\(--ink\) (\d+)%, var\(--paper\)\)/.exec(block)?.[1]) / 100;
    const [ink, paper] = [token("ink"), token("paper")];
    expect(contrast(ink.map((c, i) => c * faint + (paper[i] ?? 0) * (1 - faint)) as Rgb, paper)).toBeGreaterThanOrEqual(
      3,
    );
    expect(block).toMatch(/margin-inline: -0\.025em;\s*padding-inline: 0\.025em;/);
    expect(css).toMatch(/\.why \.sr \{\s*user-select: none;/);
    const why = between(css, /^\.why \{/m, "}");
    expect(why).toMatch(/width: min\(100% - 2 \* var\(--pad\), 22em\);/);
    expect(why).toMatch(/font-size: 28px;/);
    expect(css).toMatch(/\.why \{\s*font-size: 40px;/);
  });

  it("the sub names the QR code, the phone and presenting in at most 2 sentences and 30 words", () => {
    const sub = visibleText(between(html, /<p class="lead">/, "</p>"));
    expect(words(sub).length).toBeLessThanOrEqual(30);
    for (const noun of ["QR code", "phone", "present"]) expect(sub).toContain(noun);
    expect(sub.match(/[.]/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("the whole landing is 80 to 300 words outside product UI, open answers included", () => {
    const count = words(visibleText(html)).length;
    expect(count).toBeGreaterThanOrEqual(80);
    expect(count).toBeLessThanOrEqual(300);
  });

  it("each sentence outside product UI is at most 20 words", () => {
    // Per block: Title Case headings end with no period, so one flat text would run them into the next line.
    for (const block of main.matchAll(/<(h[1-3]|p|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      for (const sentence of visibleText(block[2] ?? "").split(/(?<=[.?])\s+/)) {
        expect(words(sentence).length, sentence).toBeLessThanOrEqual(20);
      }
    }
  });

  it("the hero has one button, Try the Demo with a trailing arrow, via /demo; the close repeats it", () => {
    const button = (section: string) => {
      const actions = between(
        between(html, new RegExp(`<section class="${section}"`), "</section>"),
        /<div class="hero-actions"/,
        "</div>",
      );
      return [...actions.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    };
    const links = button("hero");
    expect(links).toHaveLength(1);
    expect(links[0]?.[1]).toBe(' class="btn primary" href="/demo"');
    expect(visibleText(links[0]?.[2] ?? "")).toBe("Try the Demo");
    expect(links[0]?.[2]).toMatch(/Try the Demo<svg class="icon arrow dir"[^>]*>(?:<path d="[^"]+"\/>)+<\/svg>$/);
    expect(button("close").map((m) => m[0])).toEqual(links.map((m) => m[0]));
    expect(read("public/_redirects")).toMatch(/^\/demo \/s\?mode=demo 302$/m);
  });

  it("the stage is one screenshot: AVIF then WebP at 1000 and 1440 wide, sized, eager, with alt text and no text of its own", () => {
    const stage = between(html, /<div class="tilt">/, "</picture>");
    const srcset = (type: string) =>
      new RegExp(
        `<source type="image/${type}" srcset="/img/hero-viewer-1000\\.${type} 1000w, /img/hero-viewer-1440\\.${type} 1440w" sizes="[^"]+">`,
      );
    // Under 640 the phone mockup replaces the screenshot: its own sources come first, AVIF then WebP.
    const phone = (type: string) =>
      new RegExp(
        `<source media="\\(max-width: 639\\.98px\\)" type="image/${type}" srcset="/img/hero-phone-600\\.${type} 600w, /img/hero-phone-900\\.${type} 900w" sizes="calc\\(100vw - 48px\\)">`,
      );
    expect(stage).toMatch(phone("avif"));
    expect(stage).toMatch(phone("webp"));
    expect(stage.indexOf("hero-phone-900.webp")).toBeLessThan(stage.indexOf('<source type="image/avif"'));
    expect(stage).toMatch(srcset("avif"));
    expect(stage).toMatch(srcset("webp"));
    expect(stage.indexOf('<source type="image/avif"')).toBeLessThan(stage.indexOf('<source type="image/webp"'));
    const img = /<img\b[^>]*>/.exec(stage)?.[0] ?? "";
    expect(img).toContain('src="/img/hero-viewer-1440.webp" width="1440" height="828" fetchpriority="high"');
    expect(img).toContain(
      'alt="The bloop viewer showing a dog, with Present and Download buttons and a list of files"',
    );
    // The phone picture's ratio is set in CSS, so the swap shifts nothing.
    expect(read("public/css/site.css")).toMatch(/\.stage img \{\s*aspect-ratio: 1155 \/ 2366;/);
    expect(img).not.toMatch(/loading="lazy"/);
    expect(visibleText(stage)).toBe("");
    expect(stage).not.toMatch(/<(video|svg|iframe)\b/);
    expect(html).not.toMatch(/Coming Soon<\/div>|reel|class="pill"/);
  });

  it("the stills, the Connect panel and the close panel share one warm backdrop rule, and their components are glass", () => {
    const css = read("public/css/site.css");
    expect(css.match(/radial-gradient\(ellipse at 25% 25%/g)).toHaveLength(1);
    const layer = between(css, /^\.frag::before,\n\.panel::before,\n\.close-panel::before \{/m, "}");
    for (const token of ["--robin-deep", "--robin", "--amber", "--rose"]) expect(layer).toContain(`var(${token}`);
    // The shapes drift slowly by translate alone (a compositor property), and never under reduced motion.
    const moving = between(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.frag::before/, "\n}");
    expect(moving).toContain("animation: drift 40s ease-in-out infinite alternate;");
    expect(between(css, /@keyframes drift \{/, "\n}\n")).not.toMatch(/background|transform:/);
    // Liquid glass: the clear fill and its filter are their own tokens, so the nav's firm glass keeps its value.
    const clear = between(
      css,
      /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{\s*\.frag \.glass,/,
      "\n}",
    );
    expect(clear).toContain("background: var(--glass-clear);");
    expect(clear).toContain("backdrop-filter: var(--glass-clear-filter);");
    expect(read("public/css/base.css")).toMatch(
      /--glass-clear-filter: blur\(20px\) saturate\(1\.8\) brightness\(1\.05\);/,
    );
    expect(css).toMatch(/\.close-card::after \{[^}]*linear-gradient\(135deg/);
    expect(html).toContain('<span class="frag-qr-tile glass">');
    expect(html).toContain('<span class="frag-list glass">');
    expect(html).toContain('<span class="frag-pill glass">');
    expect(html).toContain('<div class="close-card glass">');
    // Download stays solid; the firm fill is restated for reduced transparency, since it outranks .glass there.
    expect(html).toContain('<button class="frag-btn ink" type="button">Download</button>');
    const solid = between(css, /@media \(prefers-reduced-transparency: reduce\) \{/, "\n}");
    for (const sel of [".close-card", ".group", ".frag .glass"]) expect(solid).toContain(sel);
    expect(solid).toContain("backdrop-filter: none;");
    // The sky tint is retired: the panels sit on the warm backdrop.
    for (const f of CSS_FILES) expect(read(`public/css/${f}`)).not.toContain("--sky");
  });

  it("How It Works has no visible heading: the section is a named landmark, the cards start its list and the step titles are h2", () => {
    const section = between(html, /<section class="how"/, "</section>");
    expect(section).toMatch(/^<section class="how" aria-label="How It Works">\s*<ol class="steps">/);
    // The step titles are the section's h2s, so heading levels step by one under the h1.
    expect(section.match(/<h2>/g)).toHaveLength(3);
    expect(section).not.toMatch(/<h[13]/);
    expect(html).not.toContain("how-h");
  });

  it("How It Works is three verb steps, each naming its device over a still with the code in groups of 3", () => {
    const steps = [...between(html, /<ol class="steps">/, "</ol>").matchAll(/<li class="step">([\s\S]*?)<\/li>/g)].map(
      (m) => m[1] ?? "",
    );
    expect(steps.map((s) => visibleText(between(s, /<h2>/, "</h2>")))).toEqual(["Scan", "Approve", "Present"]);
    for (const step of steps) expect(step).toMatch(/<span class="step-n" aria-hidden="true">\d<\/span>/);
    expect(html).not.toContain("step-device");
    expect(steps.map((s) => visibleText(between(s, /<\/h2>\s*<p>/, "</p>")))).toEqual([
      "Scan the screen's QR code with your phone camera.",
      "Choose your files, then tap Approve.",
      "Present immediately or download your file.",
    ]);
    for (const step of steps) expect(step).toMatch(/<div class="frag" role="group" aria-label="Example">/);
    // The Scan still is the QR glyph alone: ink, 64 px, no text.
    expect(steps[0]).toMatch(/<svg class="icon frag-qr"[^>]*width="64" height="64"[^>]*aria-hidden="true"/);
    expect(visibleText(between(steps[0] ?? "", /<div class="frag"/, "</div>"))).toBe("");
    // The app's own .tick is hidden outside a checked row, so the stills keep their own class.
    expect(steps[1]?.match(/class="icon frag-tick"/g)).toHaveLength(3);
    // Each row is a toggle: the deck and the dog start on, the Vevox link off.
    const rows = [
      ...(steps[1] ?? "").matchAll(
        /<button class="frag-row" type="button" aria-pressed="(true|false)">([\s\S]*?)<\/button>/g,
      ),
    ];
    expect(rows.map((m) => [visibleText(m[2] ?? ""), m[1]])).toEqual([
      ["Sample deck.pptx", "true"],
      ["Dog.jpg", "true"],
      ["Vevox", "false"],
    ]);
    // The deck's tile is its first page, shown whole, as rows.js draws it.
    expect(rows[0]?.[2]).toMatch(
      /<img class="fit" src="\/img\/demo-slide-1-thumb\.webp" width="32" height="32" alt="" loading="lazy"/,
    );
    expect(read("public/css/site.css")).toMatch(/\.frag-tile \.fit \{\s*object-fit: contain;/);
    expect(steps[2]).toMatch(
      /<button class="frag-btn" type="button">Present<\/button><button class="frag-btn ink" type="button">Download<\/button>/,
    );
    expect(read("public/js/site.js")).toMatch(/\.frag-list"\)\?\.addEventListener\("click"[\s\S]*?aria-pressed/);
    expect(html).not.toMatch(/class="(?:[^"]*\s)?tick[\s"]/);
  });

  it("the FAQ is 4 native details in order, the residue answer links to /security#stay with no nothing-stays claim, then an email line", () => {
    const faq = between(html, /<section class="faq"/, "</section>");
    const items = [...faq.matchAll(/<details>\s*<summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
    expect(items.map((m) => [m[1], visibleText(m[2] ?? "")])).toEqual([
      ["Is it free?", "Yes, while bloop is in early access."],
      ["Do I need to install anything?", "No. The screen opens bloop in its browser, and your phone uses its camera."],
      [
        "What stays on the room PC?",
        "Only a link to each item you open, and never your account. A downloaded copy or the browser's history can stay until the PC is wiped. See what can stay.",
      ],
      ["Which files work?", "PowerPoint, PDF, photos, videos and links."],
    ]);
    const residue = items[2]?.[2] ?? "";
    expect(residue).toContain('<a href="/security#stay">See what can stay.</a>');
    expect(residue.toLowerCase()).not.toMatch(/nothing (is )?left|leaves nothing/);
    expect(read("public/security.html")).toContain('id="stay"');
    expect(faq).toMatch(
      /<\/details>\s*<p class="faq-more">Another question\? Email <a href="mailto:hi@bloop\.here">hi@bloop\.here<\/a><\/p>\s*<\/section>$/,
    );
  });

  const group = (id: string) => {
    const section = between(html, new RegExp(`<section class="group" aria-labelledby="${id}">`), "</section>");
    const head = visibleText(between(section, /<div class="group-head">/, "</div>"));
    const rows = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => visibleText(m[1] ?? ""));
    return { section, head, rows };
  };

  it("the provider list promises nothing live: Coming Soon, by name only, and iCloud is not listed", () => {
    const { section, head, rows } = group("from-h");
    expect(head).toBe("Integrations Coming Soon");
    expect(rows).toEqual(["Microsoft OneDrive", "Dropbox", "Google Drive™", "Box"]);
    expect(section).not.toMatch(/<img\b/);
    expect(section.toLowerCase()).not.toContain("icloud");
  });

  it("Connect lists what can be shared today as Available, with no line under its heading", () => {
    const { section, head, rows } = group("share-h");
    expect(head).toBe("What You Can Share Available");
    expect(section).toContain('<span class="status on">Available</span>');
    expect(rows).toEqual(["PowerPoint", "PDF", "Images", "Links"]);
    expect(between(html, /<section class="connect"/, '<div class="panel">')).not.toMatch(/<p\b/);
    expect(html).not.toMatch(/one folder in the storage/);
  });

  it("Google Drive carries its ™ at its first mention on the page", () => {
    const text = visibleText(main);
    expect(text.indexOf("Google Drive")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Google Drive™")).toBe(text.indexOf("Google Drive"));
  });

  it("the features grid is six neutral cells: an icon, a title and one or two sentences; no mocks", () => {
    const grid = between(html, /<ul class="grid">/, "</ul>");
    const cells = [...grid.matchAll(/<li class="cell">([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? "");
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell).toMatch(
        /^\s*<svg class="icon"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>\s*<h3>[^<]+<\/h3>\s*<p>[\s\S]+<\/p>\s*$/,
      );
      const line = visibleText(/<p>([\s\S]*?)<\/p>/.exec(cell)?.[1] ?? "");
      expect(line.split(/(?<=\.)\s+/).length, line).toBeLessThanOrEqual(2);
    }
    expect(html).not.toMatch(/class="(bento|card|mock)[\s"-]/);
  });

  it("the residue cell admits what can stay and links to it, with no nothing-stays claim", () => {
    const cell = between(html, /<h3>Know What Can Stay<\/h3>/, "</li>");
    expect(cell).toContain('<a href="/security#stay">');
    expect(cell).toMatch(/can stay on the PC/);
    expect(read("public/security.html")).toContain('id="stay"');
    expect(visibleText(main).toLowerCase()).not.toMatch(/nothing (is )?left|leaves nothing|no trace/);
  });

  it("og:image and og:url are absolute, for link previews", () => {
    expect(html).toContain('<meta property="og:image" content="https://bloop.here/og.png">');
    expect(html).toContain('<meta property="og:url" content="https://bloop.here/">');
    expect(html).toContain('<meta property="og:image:alt" content="bloop: Present Anywhere">');
    expect(read("tools/render-og.py")).toContain("H1 = 'Present Anywhere'");
  });

  it("the logo's orange is named once, as --robin in base.css :root; its gray never leaves the logo", () => {
    const css = CSS_FILES.map((f) => read(`public/css/${f}`))
      .join("\n")
      .toLowerCase();
    expect(read("public/css/base.css")).toMatch(/^\s*--robin: #f4ba8b;$/m);
    expect(css.match(/f4ba8b/g)).toHaveLength(1);
    expect(css).toMatch(/^\s*--robin: #f4ba8b;$/m);
    for (const hex of ["646464", "ff7702"]) expect(css).not.toContain(hex);
  });

  it("the status chips and the sheen's deep end clear their contrast lines (design.md section 12)", () => {
    const css = read("public/css/base.css");
    const hex = (name: string) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(css)?.[1] ?? "";
    const lum = (h: string) => {
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(ratio("mint-ink", "mint")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("amber-ink", "amber")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("robin-deep", "paper")).toBeGreaterThanOrEqual(3);
    // A lead outranks secondary text: never lighter than --muted, and 4.5:1 or more on paper.
    expect(lum(hex("lead"))).toBeLessThanOrEqual(lum(hex("muted")));
    expect(ratio("lead", "paper")).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ALL)("%s has no robin", (page) => {
    expect(read(`public/${page}`).toLowerCase()).not.toContain("robin");
  });
});

describe("site scripts under the strict CSP", () => {
  it.each(["site.js", "legal.js"])("%s never uses eval, HTML sinks, inline styles or script URLs", (file) => {
    const code = read(`public/js/${file}`);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/new Function\s*\(/);
    expect(code).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/setTimeout\(\s*["'`]/);
    // Styling stays in CSS; script may only hand CSS a number through a custom property (CSSOM, outside the CSP).
    expect(code.replaceAll(/\.style\.setProperty\("--[\w-]+", /g, "")).not.toMatch(
      /\.style\b|setAttribute\(\s*["']style/,
    );
  });

  it("the landing script imports nothing and listens to no scroll event", () => {
    const code = read("public/js/site.js");
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/addEventListener\("scroll"|onscroll/);
  });

  it("the stage tilt springs a paused animation, only while an observer sees the stage and motion is allowed", () => {
    const code = read("public/js/site.js");
    expect(code).toContain('matchMedia("(prefers-reduced-motion: no-preference)")');
    expect(code).not.toContain("min-width");
    expect(read("public/css/site.css")).toMatch(
      /@supports \(animation-timeline: view\(\)\) \{\s*@media \(prefers-reduced-motion: no-preference\) \{\s*\.stage \{/,
    );
    expect(code).toMatch(/stage\.animate\(/);
    expect(code).toMatch(/tilt\.pause\(\)/);
    expect(code).toMatch(/tilt\.currentTime = /);
    expect(code).toMatch(/new IntersectionObserver\([\s\S]*?cancelAnimationFrame[\s\S]*?\.observe\(stage\)/);
  });

  it("every site page loads only its own script: the landing site.js, the doc pages legal.js, the 404 none", () => {
    for (const page of SITE) {
      const scripts = [...read(`public/${page}`).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
      expect(scripts, page).toEqual(page === "index.html" ? ["/js/site.js"] : isDoc(page) ? ["/js/legal.js"] : []);
    }
  });
});

describe("site chrome: one nav and one footer on every site page", () => {
  const chrome = (html: string) =>
    [between(html, /<header class="nav">/, "</header>"), between(html, /<footer class="footer">/, "</footer>")].map(
      (part) => part.replace(/ aria-current="page"/g, "").replace(/\?source=\w+/g, "?source=page"),
    );
  const [nav, footer] = chrome(read("public/index.html"));

  it.each(SITE)("%s carries the landing's nav and footer, and marks at most its own link current", (page) => {
    const html = read(`public/${page}`);
    expect(chrome(html)).toEqual([nav, footer]);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html).toContain('<nav class="nav-pill glass" aria-label="Primary">');
    const current = [...html.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    expect(new Set(current).size).toBeLessThanOrEqual(1);
    // An article marks the Articles link: the section it sits in.
    if (current[0]) expect(current[0]).toBe(ARTICLES.includes(page) ? "/articles" : `/${page.replace(".html", "")}`);
  });

  it.each(SITE)("%s lists Terms and Articles in the menu and the footer", (page) => {
    const html = read(`public/${page}`);
    for (const part of [
      between(html, /<ul class="nav-links/, "</ul>"),
      between(html, /<ul class="footer-links">/, "</ul>"),
    ]) {
      expect(part).toContain(">Terms</a>");
      expect(part).toContain(">Articles</a>");
    }
  });

  it.each(SITE)("%s links no Source repository and no /it", (page) => {
    const html = read(`public/${page}`);
    expect(html).not.toMatch(/github\.com|>Source</);
    expect(html).not.toMatch(/href="\/it[/"#?]/);
  });

  it.each([
    ["index.html", "landing"],
    ["security.html", "security"],
    ["privacy.html", "privacy"],
    ["terms.html", "terms"],
    ["404.html", "404"],
    ...ARTICLES.map((page) => [page, "articles"]),
  ])(
    "%s: every Waitlist link opens the form with source=%s, in the same tab, and carries data-waitlist",
    (page, source) => {
      const html = read(`public/${page}`);
      const links = [...html.matchAll(/<a\b([^>]*)>Waitlist<\/a>/g)].map((m) => m[1] ?? "");
      expect(links.length).toBeGreaterThanOrEqual(2);
      for (const attrs of links) {
        expect(attrs).toMatch(/\sdata-waitlist(\s|$)/);
        expect(attrs).toContain(`href="https://tally.so/r/Yj4KAN?source=${source}"`);
        expect(attrs).not.toContain("target=");
      }
      expect(html.match(/data-waitlist/g)).toHaveLength(links.length);
      expect(html).not.toContain("mailto:ventures");
    },
  );

  it.each(SITE)("%s names only hi@bloop.here, and no placeholder", (page) => {
    const html = read(`public/${page}`);
    expect(html).not.toMatch(/bloop\.example/);
    for (const m of html.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) expect(m[0]).toBe("hi@bloop.here");
  });

  it("the footer lists the address as a mailto link beside the other footer links, with its text visible", () => {
    expect(footer).toContain('<li><a href="mailto:hi@bloop.here">hi@bloop.here</a></li>');
    expect(footer).not.toContain("Write to");
  });

  it("security.txt and SECURITY.md name the /security channels and point to its policy (RFC 9116)", () => {
    const txt = read("public/.well-known/security.txt");
    expect(txt).toMatch(/^Contact: mailto:hi@bloop\.here$/m);
    expect(txt.match(/^Contact: /gm)).toHaveLength(1);
    expect(txt).not.toContain("github.com");
    expect(txt).toMatch(/^Policy: https:\/\/bloop\.here\/security#report$/m);
    expect(txt).toMatch(/^Canonical: https:\/\/bloop\.here\/\.well-known\/security\.txt$/m);
    expect(read("SECURITY.md")).toContain("https://bloop.here/security#report");
    const report = visibleText(between(read("public/security.html"), /<section id="report"/, "</section>"));
    expect(report).toContain("hi@bloop.here");
    expect(report).toContain("within 5 working days");
    expect(read("SECURITY.md")).not.toMatch(/\d+ (working )?days/);
  });

  it("privacy names Tally as the waitlist processor and what the form collects", () => {
    const html = read("public/privacy.html");
    const collected = visibleText(between(html, /<tr><th scope="row">Waitlist answers:/, "</tr>"));
    for (const field of [
      "role",
      "where you would use",
      "organization",
      "what you would like next",
      "timing",
      "email",
    ]) {
      expect(collected, field).toContain(field);
    }
    expect(visibleText(between(html, /<tr><th scope="row">Tally BV/, "</tr>"))).toContain("Waitlist answers");
  });

  it("the logo is its own pill before the nav landmark, and the links pill holds the links, Waitlist and the menu", () => {
    expect(nav).toMatch(
      /^<header class="nav">\s*<a class="brand nav-logo glass" href="\/"><img src="\/favicon\.svg" width="32" height="32" alt="">bloop<\/a>\s*<nav class="nav-pill glass"/,
    );
    // The pills take the one .glass recipe by class; base.css names no nav selector.
    expect(nav).toContain('<ul class="nav-links glass" id="nav-links" popover>');
    const pill = between(nav ?? "", /<nav class="nav-pill glass"/, "</nav>");
    expect(pill).not.toContain("brand");
    expect(pill).toMatch(/<\/ul>\s*<a class="btn waitlist"[^>]*>Waitlist<\/a>\s*<button class="nav-menu"/);
  });

  it.each(["privacy.html", "security.html"])("%s marks its own nav link as the current page", (page) => {
    const html = read(`public/${page}`);
    const own = `/${page.replace(".html", "")}`;
    expect(between(html, /<nav class="nav-pill glass"/, "</nav>")).toContain(`<a href="${own}" aria-current="page">`);
  });

  it("the menu button opens the links as a popover, with no script", () => {
    expect(nav).toMatch(/<ul class="nav-links glass" id="nav-links" popover>/);
    expect(nav).toMatch(/<button class="nav-menu" type="button" popovertarget="nav-links" aria-label="Menu">/);
  });

  it("the footer ends with the year line", () => {
    expect(footer).toMatch(/<p class="footer-legal">© 2026 bloop<\/p>\s*<\/footer>$/);
  });
});

describe("the stylesheets: base.css, then the page's own (design.md section 11)", () => {
  const css = Object.fromEntries(CSS_FILES.map((f) => [f, read(`public/css/${f}`)]));
  const links = (html: string) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  // A class names a rule in a file when it appears as a selector token there.
  const defines = (file: string, cls: string) => new RegExp(`\\.${cls}(?![\\w-])`).test(css[file] ?? "");

  it.each(SITE)("%s links base.css then site.css (then legal.css on a doc page), and nothing else", (page) => {
    const own = isDoc(page) ? ["/css/legal.css"] : [];
    expect(links(read(`public/${page}`))).toEqual(["/css/base.css", "/css/site.css", ...own]);
  });

  it.each(["s.html", "a.html", "code.html"])("%s links base.css then app.css, and nothing else", (page) => {
    expect(links(read(`public/${page}`))).toEqual(["/css/base.css", "/css/app.css"]);
  });

  it("the Worker's error page, a site page, links base.css then site.css", () => {
    expect(links(read("src/worker/auth/error-page.ts"))).toEqual(["/css/base.css", "/css/site.css"]);
  });

  it.each(SITE)("every class on %s is styled by base.css, site.css or legal.css, never only by app.css", (page) => {
    // Names for the markup's reader, with no rule of their own.
    const unstyled = new Set(["frag-name"]);
    const classes = new Set(
      [...read(`public/${page}`).matchAll(/class="([^"]+)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)),
    );
    for (const cls of classes) {
      const own = defines("base.css", cls) || defines("site.css", cls) || (isDoc(page) && defines("legal.css", cls));
      if (!own) expect(unstyled.has(cls) && !defines("app.css", cls), cls).toBe(true);
    }
  });

  it("base.css names no page's own class", () => {
    const base = css["base.css"] ?? "";
    for (const cls of [
      "page-site",
      "page-screen",
      "nav",
      "nav-logo",
      "nav-pill",
      "nav-links",
      "doc",
      "faq",
      "framed",
      "item",
      "row",
    ]) {
      expect(new RegExp(`\\.${cls}(?![\\w-])`).test(base), cls).toBe(false);
    }
  });

  // The first rule for a selector: its own block, before any width query restates it.
  const block = (sel: string) => {
    const site = css["site.css"] ?? "";
    const at = site.search(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m"));
    return at < 0 ? "" : site.slice(at, site.indexOf("}", at));
  };

  it("the site's flat content cards share --r-content; the frames that hold cards keep --r-stage", () => {
    for (const sel of [".step", ".cell", ".faq details"]) {
      expect(block(sel), sel).toContain("border-radius: var(--r-content);");
    }
    for (const sel of [".stage", ".panel"]) expect(block(sel), sel).toContain("border-radius: var(--r-stage);");
    expect(css["site.css"]).not.toMatch(/var\(--r-(card|sheet)\)/);
  });

  // A selector list is one selector per line (Biome), so a comma inside :is() never splits it.
  it("Reduce Transparency reaches every --glass-firm surface, the scrolled pills included", () => {
    const site = css["site.css"] ?? "";
    const firm = [...site.matchAll(/([^{}]+)\{\s*background: var\(--glass-firm\);/g)].flatMap((m) =>
      (m[1] ?? "").split(/,\s*\n/).map((sel) => sel.replace(/\/\*[\s\S]*?\*\//g, "").trim()),
    );
    expect(firm).toContain(".nav.is-scrolled :is(.nav-logo, .nav-pill)");
    const reduce = between(site, /@media \(prefers-reduced-transparency: reduce\) \{/, "\n}\n");
    const head = reduce.slice(reduce.indexOf("{") + 1, reduce.indexOf("{", reduce.indexOf("{") + 1));
    const solid = head.split(/,\s*\n/).map((sel) => sel.trim());
    for (const sel of firm) expect(solid, sel).toContain(sel);
    expect(reduce).toContain("background: var(--surface);");
  });

  it("a panel row is at least 56 tall and padded 12 above and below, so a wrapped row keeps its inset", () => {
    expect(block(".rows li")).toMatch(/min-height: 56px;\s*padding-block: 12px;/);
  });

  it("no site text is dimmed by opacity, which axe counts against contrast even under aria-hidden", () => {
    // The FAQ answer fades in only while it opens, so its opacity is the one allowed.
    // The menu sheet fades in only while it opens too, from its @starting-style.
    const rest = (css["site.css"] ?? "")
      .replace(/@supports \(interpolate-size: allow-keywords\) \{[\s\S]*?\n\}\n/, "")
      .replace(/@starting-style \{\s*\.nav-links:popover-open \{[^}]*\}\s*\}/, "");
    expect(rest).not.toMatch(/opacity:/);
    // On the clear glass a left-out row keeps the row's ink; only weight, an empty tile and no tick say it is off.
    expect(block('.frag-row[aria-pressed="false"]')).toMatch(/^[^{]+\{\s*font-weight: 400;\s*$/);
  });

  it("every site heading balances its lines, so a card title never ends on one word", () => {
    expect(css["base.css"]).toMatch(/h1,\s*h2 \{[^}]*text-wrap: balance;/);
    expect(css["site.css"]).toMatch(/^h3 \{\s*text-wrap: balance;\s*\}/m);
  });

  it("the steps stretch to one row height, and under 640 a cell's icon sits inline before its title", () => {
    expect(block(".step")).not.toContain("align-self");
    // From 1024 the cards share the list's rows, so every still is one height and ends 12 above its card's bottom.
    expect(block(".step")).toContain("padding: 24px 24px 12px;");
    const wide = between(css["site.css"] ?? "", /@media \(min-width: 1024px\) \{\s*\.steps,/, "\n}\n");
    expect(wide).toMatch(/\.step \{\s*display: grid;\s*grid-row: span 3;\s*grid-template-rows: subgrid;/);
    // span 3 holds only while each card has exactly three children.
    const cards = [...read("public/index.html").matchAll(/<li class="step">([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? "");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.match(/^\s*<(p|h2|div)\b/gm)).toHaveLength(3);
    }
    expect(block(".frag")).toContain("align-content: center;");
    const narrow = between(css["site.css"] ?? "", /@media \(max-width: 639\.98px\) \{\s*\.cell \{/, "\n}\n");
    expect(narrow).toContain("grid-template-columns: auto minmax(0, 1fr);");
    expect(narrow).toMatch(/\.cell p \{\s*grid-column: 1 \/ -1;/);
    // Same selectors as the base cell rules, so the query must come after them or the title keeps its top margin.
    const site = css["site.css"] ?? "";
    expect(site.indexOf(narrow)).toBeGreaterThan(site.search(/^\.cell h3 \{/m));
  });
});

describe("stage 1 wording and pictures", () => {
  const index = read("public/index.html");

  it.each(SITE)("%s titles itself bloop: X", (page) => {
    expect(read(`public/${page}`)).toMatch(/<title>bloop: [A-Z][^<]*<\/title>/);
  });

  it("the landing speaks US English and the phone's own verb: Select, then Revoke", () => {
    const text = visibleText(index);
    expect(text).not.toMatch(/\b[Tt]ick\b/);
    expect(text).toContain("Choose your files, then tap Approve.");
    expect(text).toContain("Revoke from your phone, and each link expires.");
    expect(text).not.toMatch(/End from your phone|One Tap/);
  });

  it("/security says each fact once, under its own sub, and the 404 line does not repeat its button", () => {
    const html = read("public/security.html");
    const text = visibleText(html);
    expect(html).not.toContain("What the room PC can and cannot reach");
    for (const fact of [/60 seconds/g, /12 hours/g, /Disconnect OneDrive/g, /My Apps/g, /Microsoft Entra/g]) {
      const n = (text.match(fact) ?? []).length;
      expect(n, String(fact)).toBe(1);
    }
    const notFound = read("public/404.html");
    expect(visibleText(between(notFound, /<p class="lead">/, "</p>"))).toBe("Check the address.");
    expect(notFound).toContain('<a class="btn primary" href="/">Go to the Home Page</a>');
  });

  it("the sub and the descriptions never say the account stays on the phone (the server holds a refresh token)", () => {
    for (const page of SITE) expect(read(`public/${page}`).toLowerCase()).not.toContain("stays on your phone.");
  });

  it("the sub, the meta description and og:description are one line", () => {
    const sub = "Scan the QR code, approve on your phone, and present.";
    expect(visibleText(between(index, /<p class="lead">/, "</p>"))).toBe(sub);
    expect(index).toContain(`<meta name="description" content="${sub}">`);
    expect(index).toContain(`<meta property="og:description" content="${sub}">`);
    expect(read("tools/render-og.py")).toContain(`SUB = '${sub}'`);
  });

  it("the hero centers its block in the whole first view, and Security to Waitlist is the links' gap", () => {
    const site = read("public/css/site.css");
    expect(site).toMatch(/^\.hero \{[^}]*min-height: 100vh;\s*min-height: 100svh;/m);
    expect(site).toMatch(/^\.btn\.waitlist \{[^}]*padding: 0 16px;/m);
    expect(site).not.toMatch(/\.btn\.waitlist \{[^}]*margin-left/);
  });

  it.each(["security.html", "privacy.html"])("%s draws the split with a check and a muted Never, no switch", (page) => {
    const html = read(`public/${page}`);
    const rows = (id: string) =>
      [...between(html, new RegExp(`<h2 id="${id}">`), "</ul>").matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
        (m) => m[1] ?? "",
      );
    for (const row of rows("gets")) expect(row).toMatch(/<svg class="icon yes"[^>]*aria-hidden="true"/);
    for (const row of rows("never")) expect(row).toMatch(/<span class="never" aria-hidden="true">Never<\/span>$/);
    expect(html).not.toContain("toggle");
    // Read with "Never", the column names what the screen lacks.
    expect(html).toContain('<h2 id="never">What the Screen Never Gets</h2>');
    expect(html).not.toContain("What Stays on Your Phone");
  });

  it("every Connect row carries a Lucide glyph: the share kinds their own, each provider the generic cloud", () => {
    const rows = (id: string) => between(index, new RegExp(`<section class="group" aria-labelledby="${id}">`), "</ul>");
    expect(rows("share-h").match(/<li><svg class="icon"[^>]*aria-hidden="true"/g)).toHaveLength(4);
    expect(
      rows("from-h").match(
        /<li><svg class="icon"[^>]*aria-hidden="true"[^>]*><path d="M17\.5 19H9a7 7 0 1 1 6\.71-9h1\.79a4\.5 4\.5 0 1 1 0 9Z"\/><\/svg>/g,
      ),
    ).toHaveLength(4);
    expect(rows("from-h")).not.toMatch(/<img\b/);
  });

  it("the group titles are visible beside their status chip and the close has no heading", () => {
    expect(index).toContain('<h3 id="share-h">What You Can Share</h3><span class="status on">');
    expect(index).toContain('<h3 id="from-h">Integrations</h3><span class="status">');
    expect(between(index, /<section class="close"/, "</section>")).not.toMatch(/<h[1-6]\b/);
    expect(index).toContain('<section class="close" aria-label="Try the demo">');
  });

  it("the menu button holds menu and close; CSS swaps them on :popover-open, with no script", () => {
    const button = between(index, /<button class="nav-menu"/, "</button>");
    expect(button).toMatch(/class="icon menu-open"[\s\S]*class="icon menu-close"/);
    expect(read("public/css/site.css")).toMatch(
      /\.nav-links:popover-open ~ \.nav-menu \.menu-close \{\s*display: block;/,
    );
  });

  it("AUTH-07 copy: /security and /privacy name bloop's own Disconnect first, as the code does it, then My Apps and Entra", () => {
    const text = visibleText(read("public/security.html"));
    // The claim's ground: the phone's button, and a route that deletes the grant and every session at once.
    expect(read("public/js/core/copy-phone.js")).toMatch(/id: "disconnect", label: "Disconnect OneDrive"/);
    const route = between(read("src/worker/routes/auth.ts"), /"\/api\/me\/disconnect"/, "),\n  ),");
    expect(route).toMatch(/vault\.delete\(userId\)/);
    expect(route).toMatch(/sessions\.destroyAll\(userId\)/);
    // One pair of sentences for the same claim on both pages.
    const access =
      /[Oo]nce OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop ?deletes its stored access and every sign-in ends at once, a lost phone's included\. You may also be able to remove bloop ?in My Apps \(myapplications\.microsoft\.com\); your IT team can remove it for everyone in Microsoft Entra\./;
    expect(text).toMatch(access);
    expect(visibleText(read("public/privacy.html"))).toMatch(access);
    // Sign-In and Permissions holds every removal step, the lost phone's included; the threats only point to it.
    const remove = visibleText(between(read("public/security.html"), /<h2 id="permissions-h">/, "</section>"));
    expect(remove).toMatch(/^Sign-In and Permissions /);
    // One sentence covers a lost phone, so the card says it once.
    expect(remove).toMatch(/a lost phone's included\./);
    expect(remove).not.toMatch(/Lost phone:/);
    const threats = visibleText(between(read("public/security.html"), /<h2 id="threats-h">/, "</section>"));
    expect(threats).toMatch(/Lost phone: see Sign-In and Permissions ?\./);
    expect(threats).not.toMatch(/Disconnect|My Apps|Entra/);
    expect(read("public/security.html")).toContain('<a href="#permissions">Sign-In and Permissions</a>');
    // Admin consent can keep a user from removing the app, so My Apps is never promised.
    for (const page of ["security.html", "privacy.html"]) {
      expect(visibleText(read(`public/${page}`)), page).not.toMatch(/You can (also )?remove bloop ?in My Apps/);
    }
    // My Apps and Entra end only the refresh token; bloop's own sessions stay, so neither is said to sign anyone out.
    for (const page of ["security.html", "privacy.html"]) {
      expect(visibleText(read(`public/${page}`)), page).not.toMatch(/(My Apps|Entra)[^.]*sign(s|ed)? (you )?out/);
    }
    // The lengths the Worker enforces (wrangler.jsonc): the default the phone can change, and the caps.
    expect(text).toContain(
      "after 1 hour unless you change it on your phone, and never later than the limit, 12 hours (2 hours in the Demo)",
    );
    const vars = read("wrangler.jsonc");
    expect(vars).toContain('"SESSION_DEFAULT_MINUTES": "60"');
    expect(vars).toContain('"SESSION_MAX_MINUTES": "720"');
    expect(vars).toContain('"DEMO_MAX_MINUTES": "120"');
    expect(text).toMatch(/Choosing the Session length on your phone ?Live/);
  });
});

describe("privacy notice", () => {
  const html = read("public/privacy.html");
  const row = (start: string) => visibleText(between(html, new RegExp(`<tr><th scope="row">${start}`), "</tr>"));

  it("keeps the OneDrive grant only as the code does: until disconnect, a failed refresh after removal, erasure, or 30 days unused", () => {
    expect(row("Your OneDrive access \\(Planned\\)")).toContain(
      "Until you tap Disconnect OneDrive (deleted at once), remove bloop in My Apps or Microsoft Entra (deleted the next time it fails), ask for erasure, or 30 days unused",
    );
    expect(read("docs/threat-model.md")).toMatch(
      /\| refresh token \(grant\) \| D1 \| until disconnect \(at once, with every phone session\)/,
    );
  });

  it("states the audit retention the Worker runs, and the request logs as the threat model does", () => {
    expect(row("Session and access records")).toContain("180 days. In the Demo, 7 days");
    expect(read("wrangler.jsonc")).toMatch(/"AUDIT_RETENTION_DAYS": "180"[\s\S]*"DEMO_RETENTION_DAYS": "7"/);
    // An IP address is personal data, so the notice names it rather than claiming none.
    expect(row("Cloudflare's request logs")).toContain(
      "Off on the live site. If they are turned on, they record each request's details, including your IP address, and keep them at most 7 days",
    );
    expect(read("docs/threat-model.md")).toMatch(
      /\| Worker logs \| Cloudflare \| off on the live Worker[^|]*if turned on, request details including the IP address, at most 7 days \|/,
    );
  });

  it("keeps waitlist answers as threat-model section 10 does: until deletion is asked or the waitlist closes", () => {
    const kept = row("Waitlist answers<\\/th>");
    expect(kept).toContain("Until you ask bloop to delete them, or the waitlist closes");
    expect(read("docs/threat-model.md")).toMatch(
      /\| waitlist:[^|]*\| Tally[^|]*\| until they ask for deletion or the waitlist closes \|/,
    );
  });

  it("covers mail to the one address, hi@, wherever it names mail", () => {
    for (const start of ["Emails you send", "Emails to"]) expect(row(start)).toContain("hi@bloop.here");
    expect(visibleText(between(html, /<tr><th scope="row">Apple/, "</tr>"))).toContain(
      "The mailbox behind hi@bloop.here Emails you send",
    );
  });

  it("names the ICO without a postal address or helpline it cannot keep current", () => {
    expect(html).toContain('<a href="https://ico.org.uk/make-a-complaint/">ico.org.uk/make-a-complaint</a>');
    expect(html).not.toMatch(/ICO_POSTAL_ADDRESS|0303/);
  });

  it("drops the draft line and the noindex", () => {
    expect(html).not.toContain("draft");
    expect(html).not.toContain('name="robots"');
  });
});

describe("the doc pages: one .legal layout (design.md section 6, Legal pages)", () => {
  const pages = Object.fromEntries(LEGAL.map((p) => [p, read(`public/${p}`)]));
  const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const sections = (html: string) =>
    [
      ...html.matchAll(
        /<section id="([^"]+)" aria-labelledby="\1-h">\s*<h2 id="\1-h">([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/g,
      ),
    ].map((m) => ({ id: m[1] ?? "", heading: m[2] ?? "", body: m[3] ?? "" }));

  it.each(LEGAL)("%s carries the header block: its effective date and version are its latest change", (page) => {
    const html = pages[page] ?? "";
    const meta = between(html, /<p class="meta">/, "</p>");
    const [, iso, us] = /<time datetime="(\d{4}-\d{2}-\d{2})">([A-Z][a-z]+ \d{1,2}, \d{4})<\/time>/.exec(meta) ?? [];
    expect(new Date(`${us} UTC`).toISOString().slice(0, 10)).toBe(iso);
    // Every legal page lists its versions under #changes, the latest first. No older copy is kept as a page.
    const changes = [
      ...between(html, /<section id="changes"/, "</section>").matchAll(
        /<li>Version (\d+\.\d+), <time datetime="([\d-]+)">/g,
      ),
    ].map((m) => ({ version: m[1], iso: m[2] }));
    expect(changes.length).toBeGreaterThan(0);
    const [latest, ...older] = changes;
    expect(latest?.iso).toBe(iso);
    expect(
      readdirSync(fileURLToPath(new URL("../../public", import.meta.url))).filter((f) => /^(privacy|terms)-/.test(f)),
    ).toEqual([]);
    expect(visibleText(meta)).toMatch(
      new RegExp(
        `Version ${(latest?.version ?? "").replace(".", "\\.")} · ${older.length ? "Previous" : "No previous"} versions$`,
      ),
    );
    expect(meta).toContain(`<a href="#changes">${older.length ? "Previous" : "No previous"} versions</a>`);
    expect(visibleText(between(html, /<section id="changes"/, "</section>"))).toContain(
      older.length ? "Version" : "Earlier versions were shown for review before this one",
    );
  });

  it.each(LEGAL)("%s leaves no placeholder or flag from the copy", (page) => {
    expect(pages[page]).not.toMatch(/EFFECTIVE_DATE|ICO_POSTAL_ADDRESS|\[FLAG|TODO/);
  });

  it.each(["privacy.html", "terms.html"])(
    "%s numbers its sections and clauses in order, each number its own anchor",
    (page) => {
      const html = pages[page] ?? "";
      const list = sections(html);
      expect(list.length).toBeGreaterThanOrEqual(12);
      list.forEach(({ id, heading, body }, i) => {
        const n = i + 1;
        expect(heading, id).toMatch(new RegExp(`^<a class="num" href="#${id}">${n}</a> `));
        const clauses = [
          ...body.matchAll(/<p class="clause" id="([\d.]+)"><a class="num" href="#([\d.]+)">([\d.]+)<\/a> /g),
        ];
        expect(clauses.length, id).toBeGreaterThan(0);
        clauses.forEach((m, j) => {
          expect([m[1], m[2], m[3]], id).toEqual(Array(3).fill(`${n}.${j + 1}`));
        });
        for (const item of body.matchAll(/<li id="([^"]+)"><a class="num" href="#([^"]+)">\(([a-z])\)<\/a> /g)) {
          expect(item[1]).toBe(item[2]);
          expect(item[1]).toMatch(new RegExp(`^${n}\\.\\d+${item[3]}$`));
        }
      });
    },
  );

  it.each(["privacy.html", "terms.html"])("%s marks every In short line as not binding, for every reader", (page) => {
    const html = pages[page] ?? "";
    const doc = page === "privacy.html" ? "this notice" : "the terms";
    expect(visibleText(html)).toContain(
      `The 'In short' lines help you read. They are not part of ${doc}; the full text is what applies.`,
    );
    const shorts = [...html.matchAll(/<p class="short">([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? "");
    expect(shorts.length).toBeGreaterThanOrEqual(11);
    for (const s of shorts)
      expect(s).toMatch(/^<span class="sr">Summary, not binding: <\/span><strong>In short:<\/strong> /);
    expect(visibleText(between(html, /<div class="summary">/, "</div>"))).toMatch(
      /This summary helps you read; the full text applies\.$/,
    );
  });

  it("/security is not a contract: no numbers and no In short lines", () => {
    const html = pages["security.html"] ?? "";
    expect(html).not.toContain('class="short"');
    expect(html).not.toContain('class="num"');
    expect(html).not.toContain("In short");
  });

  it.each(LEGAL)("%s lists every section in its contents, in order, with no second nav landmark", (page) => {
    const html = pages[page] ?? "";
    const toc = [...between(html, /<section class="toc"/, "</section>").matchAll(/<a href="#([^"]+)">/g)].map(
      (m) => m[1],
    );
    expect(toc).toEqual(sections(html).map((s) => s.id));
    expect(between(html, /<section class="toc"/, "</section>")).toContain('<h2 id="toc-h">On This Page</h2>');
  });

  it.each(LEGAL)("%s links only to anchors that exist, on its own page or another doc page", (page) => {
    const html = pages[page] ?? "";
    for (const m of html.matchAll(/href="(\/(privacy|terms|security))?#([^"]+)"/g)) {
      const target = m[2] ? (pages[`${m[2]}.html`] ?? "") : html;
      expect(ids(target).has(m[3]), m[0]).toBe(true);
    }
  });

  it.each(LEGAL)("%s keeps the landing's anchors: /security#stay and /security#report", (page) => {
    if (page !== "security.html") return;
    for (const id of ["stay", "report", "status", "how"]) expect(ids(pages[page] ?? "").has(id), id).toBe(true);
    expect(read("public/index.html")).toContain('href="/security#stay"');
  });

  it("each defined term is bold where it is defined", () => {
    const defs = visibleText(between(pages["privacy.html"] ?? "", /<p class="clause" id="1\.4">/, "</p>"));
    expect(defs).toMatch(/^1\.4 Words used here:/);
    const html = between(pages["privacy.html"] ?? "", /<p class="clause" id="1\.4">/, "</p>");
    for (const term of ["Screen", "Session", "Item", "Guest File", "Demo"]) {
      expect(html).toContain(`<strong>${term}</strong> means`);
    }
  });

  it("/security claims nothing the main branch has not shipped", () => {
    const text = visibleText(pages["security.html"] ?? "");
    // The status row names exactly the photo and video types a guest may send (shared/names.js).
    const media = [...new Set(Object.values(EXTENSION_TYPES))].filter((t) => t !== "pptx" && t !== "pdf");
    expect(media).toEqual(["jpg", "png", "mp4", "mov"]);
    expect(text).toContain("Guest photos (JPEG, PNG) and videos (MP4, MOV), cleaned on the phone Live");
    // The session length and the remote shipped: their routes, and the phone's remote that sends to one.
    expect(read("src/worker/routes/control.ts")).toContain('"/api/session/length"');
    expect(read("public/js/core/remote-ui.js")).toContain('"/api/control"');
    expect(text).toContain("Controlling the Screen from your phone (next, previous, present) Live");
    const statuses = [...(pages["security.html"] ?? "").matchAll(/<span class="status( on)?">(\w+)<\/span>/g)].map(
      (m) => [m[2], !!m[1]],
    );
    for (const [label, on] of statuses) expect(on, label as string).toBe(label === "Live");
  });

  it("legal.css owns the .legal rules: the doc layout is in no other stylesheet, and print hides the chrome", () => {
    const legal = read("public/css/legal.css");
    for (const file of ["site.css", "base.css", "app.css"]) {
      expect(read(`public/css/${file}`), file).not.toMatch(/\.(legal|toc|clause|short)(?![\w-])/);
    }
    expect(legal).toContain("--measure: 68ch;");
    const print = between(legal, /@media print \{/, "\n}\n");
    for (const sel of [".nav", ".footer", ".toc", ".copied"]) expect(print, sel).toContain(sel);
    expect(legal).not.toMatch(/var\(--sky\)/);
  });
});

describe("landing motion and spacing (design.md sections 6 and 8)", () => {
  const css = read("public/css/site.css");

  it("the word's sheen sweeps every 3 s with no rest on its own keyframe; the loader keeps sheen's 2.2 s and rest", () => {
    expect(css).toMatch(/animation: sweep 3s linear 0\.3s infinite backwards;/);
    expect(css).not.toMatch(/animation: sheen/);
    expect(between(read("public/css/base.css"), /@keyframes sheen \{/, "\n}\n")).toMatch(/\n {2}45%,\n {2}100% \{/);
    expect(read("public/css/app.css")).toMatch(/animation: sheen 2\.2s linear infinite;/);
  });

  it("where :popover-open is invalid (Safari 15, 16), no shared rule drops and the narrow nav shows its links", () => {
    for (const m of css.matchAll(/(?:^|[}/])\s*([^{}@/]+)\{/g)) {
      const list = (m[1] ?? "").trim().split(/,\s*(?![^()]*\))/);
      if (list.length < 2) continue;
      // A bare :popover-open in a list would take the other selectors down with it.
      for (const sel of list)
        expect(sel.replace(/:is\([^()]*:popover-open\)/g, ""), sel).not.toContain(":popover-open");
    }
    const fallback = between(css, /@supports not selector\(:popover-open\) \{/, "\n}\n");
    expect(fallback).toMatch(/@media \(max-width: 759\.98px\) \{\s*\.nav-menu \{\s*display: none;/);
    expect(fallback).toMatch(/\.nav-links \{[^}]*position: fixed;[^}]*overflow-x: auto;/);
    // A filter would make the pill the fixed row's containing block and box the row inside it.
    expect(fallback).toMatch(/\.nav-pill,\s*\.nav\.is-scrolled \.nav-pill \{[^}]*backdrop-filter: none;/);
    // :not(:is(:popover-open)) matches everything where the pseudo-class is unknown; a lone rule stays bare.
    expect(css).not.toMatch(/:not\(:is\([^()]*:popover-open\)\)/);
    // The rule that hides the list is a bare :not(:popover-open), so those engines drop it and the list shows.
    expect(between(css, /@media \(max-width: 759\.98px\) \{/, "\n}\n")).toMatch(
      /\.nav-links:not\(:popover-open\) \{\s*display: none;/,
    );
    expect(read("public/js/site.js")).not.toContain(":popover-open");
  });

  it("the sheen and the 5 backdrop drifts pause off screen and in a hidden tab, one rule after every animated one", () => {
    const js = read("public/js/site.js");
    expect(js).toMatch(/querySelectorAll\("\.sheen, \.frag, \.panel, \.close-panel"\)\) watch\.observe\(el\)/);
    expect(js).toMatch(/addEventListener\("visibilitychange", pause\)/);
    expect(js).toMatch(/toggle\("is-paused", !on \|\| document\.hidden\)/);
    const rule = css.search(
      /^\.is-paused,\n\.is-paused::before,\n\.hero h1:hover \.sheen,\n\.hero:focus-within \.sheen \{\n {2}animation-play-state: paused;/m,
    );
    expect(rule).toBeGreaterThan(0);
    for (const m of css.matchAll(/^\s*animation: /gm)) expect(m.index ?? 0).toBeLessThan(rule);
    // The doc pages' one panel pauses its drift the same way.
    const legal = read("public/js/legal.js");
    expect(legal).toMatch(/document\.querySelector\("\.panel"\)/);
    expect(legal).toMatch(/toggle\("is-paused", !on \|\| document\.hidden\)/);
    expect(legal).toMatch(/addEventListener\("visibilitychange", pause\)/);
  });

  it("the steps sit 40 under the stage, 56 from 768", () => {
    expect(css).toMatch(/^\.how \{\s*padding-top: 40px;\s*\}/m);
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*\.how \{\s*padding-top: 56px;/);
  });

  it("from 760 the two nav pills center as one pair, 20 apart; under 760 they part to the edges", () => {
    expect(css).toMatch(/^\.nav \{[^}]*display: flex;\s*justify-content: center;\s*align-items: center;\s*gap: 20px;/m);
    expect(css).toMatch(/@media \(max-width: 759\.98px\) \{\s*\.nav \{[^}]*justify-content: space-between;/);
    expect(css).not.toMatch(/grid-template-columns: 1fr auto/);
  });

  it("a tap acts at once on the site pages, and the menu sheet enters by transform and opacity in 180 ms", () => {
    expect(css).toMatch(/^html:has\(\.page-site\) \{[^}]*touch-action: manipulation;/m);
    const sheet = between(css, /@media \(max-width: 759\.98px\) \{/, "\n}\n");
    expect(sheet).toMatch(/transition:\s*opacity 180ms var\(--ease-out\),\s*transform 180ms var\(--ease-out\);/);
    expect(sheet).toMatch(/@starting-style \{\s*\.nav-links:popover-open \{\s*opacity: 0;\s*transform: [^;]+;\s*\}/);
  });
});
