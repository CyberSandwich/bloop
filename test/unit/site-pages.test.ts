import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALPHABET } from "../../public/js/shared/codes.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const SITE = ["index.html", "security.html", "privacy.html", "404.html"] as const;
const ALL = [...SITE, "s.html", "a.html", "code.html"] as const;
const VOID = new Set(["meta", "link", "img", "source", "input", "br", "hr", "wbr"]);
const CSS_FILES = ["base.css", "site.css", "app.css"] as const;
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

  it("every heading and label is at most 5 words", () => {
    const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => m[2] as string);
    const labels = [...html.matchAll(/<span class="(?:status|frag-label)[^"]*">([^<]*)<\/span>/g)].map(
      (m) => m[1] as string,
    );
    for (const text of [...headings, ...labels].map((t) => visibleText(t))) {
      expect(words(text).length, text).toBeLessThanOrEqual(5);
    }
  });

  it("every heading and the title are Title Case with no period (design.md section 3)", () => {
    const titles = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => visibleText(m[2] as string));
    titles.push((/<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "").replace(/^bloop:? /, ""));
    for (const title of titles) {
      expect(title, title).not.toMatch(/[.]$/);
      words(title).forEach((word, i) => {
        if (word === "bloop" || (i > 0 && MINOR.has(word.replace(/,$/, "")))) return;
        expect(word[0], `${word} in "${title}"`).toBe(word[0]?.toUpperCase());
      });
    }
  });

  it("draws icons in the Iconic style: inline, 1.5 stroke, round caps, hidden from screen readers", () => {
    for (const m of html.matchAll(/<svg\b[^>]*>/g)) {
      expect(m[0]).toContain('stroke-width="1.5"');
      expect(m[0]).toContain('stroke-linecap="round"');
      expect(m[0]).toContain('aria-hidden="true"');
    }
  });

  it('sets "bloop" in body copy as the robin name', () => {
    // The legal line is a name in a notice, not copy; a mail domain is an address.
    for (const m of html.matchAll(/<p(?! class="footer-legal")\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const bare = (m[1] as string)
        .replace(/<b class="name">bloop<\/b>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\S+@bloop\.\S+/g, "");
      expect(bare, m[1]).not.toMatch(/\bbloop\b/);
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

  it.each(SITE)("%s keeps session, token and tenant off the page unless it is /security", (page) => {
    if (page === "security.html") return;
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

  it("Anywhere rests in solid deep robin; its one sheen plays once, and never under reduced motion", () => {
    const css = read("public/css/site.css");
    expect(css).toMatch(/^\.sheen \{\s*color: var\(--robin-deep\);\s*\}/m);
    const block = between(css, /@supports \(background-clip: text\)/, "@keyframes sheen");
    const moving = between(block, /prefers-reduced-motion: no-preference\) \{/, "}");
    expect(moving).toMatch(
      /background-clip: text;[^}]*color: transparent;[^}]*animation: sheen [\d.]+s var\(--ease-out\) [\d.]+s backwards;/,
    );
    // The band is the only gradient; under it the fill is the rest color, so the word never rests as a gradient.
    expect(moving.match(/linear-gradient/g)).toHaveLength(1);
    expect(moving).toMatch(/no-repeat var\(--robin-deep\);/);
    expect(css).not.toMatch(/\.sheen[^{]*\{[^}]*infinite/);
    expect(css).not.toMatch(/text-shadow/);
  });

  it("the sub names phone, screen and file in at most 2 sentences and 30 words", () => {
    const sub = visibleText(between(html, /<p class="lead">/, "</p>"));
    expect(words(sub).length).toBeLessThanOrEqual(30);
    for (const noun of ["phone", "screen", "file"]) expect(sub).toContain(noun);
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
    expect(links[0]?.[2]).toMatch(/Try the Demo<svg class="icon arrow"[^>]*><path d="[^"]+"\/><\/svg>$/);
    expect(button("close").map((m) => m[0])).toEqual(links.map((m) => m[0]));
    expect(read("public/_redirects")).toMatch(/^\/demo \/s\?mode=demo 302$/m);
  });

  it("the stage is one screenshot: AVIF then WebP at 1000 and 1440 wide, sized, eager, with alt text and no text of its own", () => {
    const stage = between(html, /<div class="tilt">/, "</picture>");
    const srcset = (type: string) =>
      new RegExp(
        `<source type="image/${type}" srcset="/img/hero-viewer-1000\\.${type} 1000w, /img/hero-viewer-1440\\.${type} 1440w" sizes="[^"]+">`,
      );
    expect(stage).toMatch(srcset("avif"));
    expect(stage).toMatch(srcset("webp"));
    expect(stage.indexOf("image/avif")).toBeLessThan(stage.indexOf("image/webp"));
    const img = /<img\b[^>]*>/.exec(stage)?.[0] ?? "";
    expect(img).toContain('src="/img/hero-viewer-1440.webp" width="1440" height="828" fetchpriority="high"');
    expect(img).toContain('alt="The Demo Room screen showing a list of files and a dog on the stage"');
    expect(img).not.toMatch(/loading="lazy"/);
    expect(visibleText(stage)).toBe("");
    expect(stage).not.toMatch(/<(video|svg|iframe)\b/);
    expect(html).not.toMatch(/Coming Soon<\/div>|reel|class="pill"/);
  });

  it("How It Works is three verb steps, each naming its device over a still with the code in groups of 3", () => {
    const steps = [...between(html, /<ol class="steps">/, "</ol>").matchAll(/<li class="step">([\s\S]*?)<\/li>/g)].map(
      (m) => m[1] ?? "",
    );
    expect(steps.map((s) => visibleText(between(s, /<h3>/, "</h3>")))).toEqual(["Scan", "Approve", "Present"]);
    for (const step of steps) expect(step).toMatch(/<span class="step-n" aria-hidden="true">\d<\/span>/);
    expect(steps.map((s) => /<p class="step-device">[\s\S]*?<\/svg>([^<]+)<\/p>/.exec(s)?.[1])).toEqual([
      "Room Screen",
      "Your Phone",
      "Room Screen",
    ]);
    for (const step of steps) expect(step).toMatch(/<div class="frag" aria-hidden="true">/);
    const code = /<span class="frag-code">([^<]+)<\/span>/.exec(steps[0] ?? "")?.[1] ?? "";
    expect(code).toMatch(new RegExp(`^[${ALPHABET}]{3} [${ALPHABET}]{3}$`));
    // The app's own .tick is hidden outside a checked row, so the stills keep their own class.
    expect(steps[1]?.match(/class="icon frag-tick"/g)).toHaveLength(2);
    expect(html).not.toMatch(/class="(?:[^"]*\s)?tick[\s"]/);
  });

  it("the FAQ is at most 4 native details, and the residue answer links to /security without a nothing-stays claim", () => {
    const faq = between(html, /<section class="faq"/, "</section>");
    const items = [...faq.matchAll(/<details>\s*<summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(4);
    const residue = items.find((m) => /room PC keep/.test(m[1] ?? ""))?.[2] ?? "";
    expect(residue).toContain('href="/security"');
    expect(residue).toMatch(/can stay/);
    expect(residue.toLowerCase()).not.toMatch(/nothing (is )?left|leaves nothing/);
    // One claim, one sentence (design.md section 13): the answer repeats /security#stay word for word.
    const stay = visibleText(between(read("public/security.html"), /<h2 id="stay">[^<]*<\/h2>\s*<p>/, "</p>")).replace(
      /^What Can Stay Behind /,
      "",
    );
    expect(visibleText(residue)).toContain(stay);
    expect(stay).toMatch(/tabs with their history/);
  });

  const group = (id: string) => {
    const section = between(html, new RegExp(`<section class="group" aria-labelledby="${id}">`), "</section>");
    const head = visibleText(between(section, /<div class="group-head">/, "</div>"));
    const rows = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => visibleText(m[1] ?? ""));
    return { section, head, rows };
  };

  it("the provider list promises nothing live: Coming Soon, by name only, and iCloud is not listed", () => {
    const { section, head, rows } = group("from-h");
    expect(head).toBe("Where Files Live Coming Soon");
    expect(rows).toEqual(["Microsoft OneDrive", "Dropbox", "Google Drive™", "Box"]);
    expect(section).not.toMatch(/<(svg|img)\b/);
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
    expect(html).toContain('<meta property="og:image" content="https://bloop.dsap.workers.dev/og.png">');
    expect(html).toContain('<meta property="og:url" content="https://bloop.dsap.workers.dev/">');
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
    expect(code).not.toMatch(/addEventListener\("scroll"|onscroll/);
  });

  it("the stage tilt springs a paused animation, only while an observer sees the stage and motion is allowed", () => {
    const code = read("public/js/site.js");
    expect(code).toContain('matchMedia("(prefers-reduced-motion: no-preference) and (min-width: 900px)")');
    expect(code).toMatch(/stage\.animate\(/);
    expect(code).toMatch(/tilt\.pause\(\)/);
    expect(code).toMatch(/tilt\.currentTime = /);
    expect(code).toMatch(/new IntersectionObserver\([\s\S]*?cancelAnimationFrame[\s\S]*?\.observe\(stage\)/);
  });

  it("every site page loads only the landing script, or none", () => {
    for (const page of SITE) {
      const scripts = [...read(`public/${page}`).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
      expect(scripts, page).toEqual(page === "index.html" ? ["/js/site.js"] : []);
    }
  });
});

describe("site chrome: one nav and one footer on every site page", () => {
  const chrome = (html: string) =>
    [between(html, /<header class="nav">/, "</header>"), between(html, /<footer class="footer">/, "</footer>")].map(
      (part) => part.replace(/ aria-current="page"/g, ""),
    );
  const [nav, footer] = chrome(read("public/index.html"));

  it.each(SITE)("%s carries the landing's nav and footer, and marks at most its own link current", (page) => {
    const html = read(`public/${page}`);
    expect(chrome(html)).toEqual([nav, footer]);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html).toContain('<nav class="nav-pill glass" aria-label="Primary">');
    const current = [...html.matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    expect(new Set(current).size).toBeLessThanOrEqual(1);
    if (current[0]) expect(current[0]).toBe(`/${page.replace(".html", "")}`);
  });

  it.each(SITE)("%s links no Source repository and no /it", (page) => {
    const html = read(`public/${page}`);
    expect(html).not.toMatch(/github\.com|>Source</);
    expect(html).not.toMatch(/href="\/it[/"#?]/);
  });

  it.each(SITE)("%s: every Waitlist link is the waitlist mail and carries data-waitlist", (page) => {
    const html = read(`public/${page}`);
    const links = [...html.matchAll(/<a\b([^>]*)>Waitlist<\/a>/g)].map((m) => m[1] ?? "");
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const attrs of links) {
      expect(attrs).toMatch(/\sdata-waitlist(\s|$)/);
      const href = /href="mailto:ventures@saputra\.co\.uk\?subject=[^"&]+&amp;body=([^"&]+)"/.exec(attrs)?.[1] ?? "";
      for (const field of ["Name:", "University or company:", "Role:"]) {
        expect(decodeURIComponent(href)).toContain(`\n${field}`);
      }
    }
    expect(html.match(/data-waitlist/g)).toHaveLength(links.length);
  });

  it.each(SITE)("%s names one contact address, ventures@saputra.co.uk, and no placeholder", (page) => {
    const html = read(`public/${page}`);
    expect(html).not.toMatch(/bloop\.example/);
    for (const m of html.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) expect(m[0]).toBe("ventures@saputra.co.uk");
  });

  it("the footer shows the address as plain text", () => {
    expect(footer).toContain("<p>Write to ventures@saputra.co.uk.</p>");
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

  it.each(SITE)("%s links base.css then site.css, and nothing else", (page) => {
    expect(links(read(`public/${page}`))).toEqual(["/css/base.css", "/css/site.css"]);
  });

  it.each(["s.html", "a.html", "code.html"])("%s links base.css then app.css, and nothing else", (page) => {
    expect(links(read(`public/${page}`))).toEqual(["/css/base.css", "/css/app.css"]);
  });

  it("the Worker's error page, a site page, links base.css then site.css", () => {
    expect(links(read("src/worker/auth/error-page.ts"))).toEqual(["/css/base.css", "/css/site.css"]);
  });

  it.each(SITE)("every class on %s is styled by base.css or site.css, never only by app.css", (page) => {
    // Names for the markup's reader, with no rule of their own.
    const unstyled = new Set(["frag-name"]);
    const classes = new Set(
      [...read(`public/${page}`).matchAll(/class="([^"]+)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)),
    );
    for (const cls of classes) {
      const own = defines("base.css", cls) || defines("site.css", cls);
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
    for (const sel of [".step", ".cell", ".faq details", ".topic"]) {
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
    const rest = (css["site.css"] ?? "").replace(/@supports \(interpolate-size: allow-keywords\) \{[\s\S]*?\n\}\n/, "");
    expect(rest).not.toMatch(/opacity:/);
    expect(block(".frag-row.off")).toContain("color: var(--muted);");
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
    expect(wide).toMatch(/\.step \{\s*display: grid;\s*grid-row: span 4;\s*grid-template-rows: subgrid;/);
    // span 4 holds only while each card has exactly four children.
    const cards = [...read("public/index.html").matchAll(/<li class="step">([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? "");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.match(/^\s*<(p|h3|div)\b/gm)).toHaveLength(4);
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
    expect(text).toContain("Select your files, then tap Approve.");
    expect(text).toContain("Your files open. Revoke from your phone.");
    expect(text).toContain("Revoke from your phone, and each link expires.");
    expect(text).not.toMatch(/End from your phone|One Tap/);
  });

  it("/security says each fact once, under its own sub, and the 404 line does not repeat its button", () => {
    const html = read("public/security.html");
    const text = visibleText(html);
    expect(visibleText(between(html, /<p class="lead">/, "</p>"))).toBe("What the room PC can and cannot reach.");
    expect(html).toContain('<meta name="description" content="What the room PC can and cannot reach.">');
    for (const fact of [/60 seconds/g, /90 minutes/g, /Disconnect OneDrive/g, /My Apps/g, /Microsoft Entra/g]) {
      const n = (text.match(fact) ?? []).length;
      expect(n, String(fact)).toBe(1);
    }
    const notFound = read("public/404.html");
    expect(visibleText(between(notFound, /<p class="lead">/, "</p>"))).toBe("Check the address.");
    expect(notFound).toContain('<a class="btn primary" href="/">Go to the Home Page</a>');
  });

  it("the sub and the descriptions never say the account stays on the phone (the server holds a refresh token)", () => {
    for (const page of SITE) expect(read(`public/${page}`).toLowerCase()).not.toContain("stays on your phone.");
    expect(visibleText(between(index, /<p class="lead">/, "</p>"))).toContain("the screen never gets your account");
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

  it("the Connect lists carry no glyph on either side", () => {
    expect(between(index, /<div class="panel">/, "</section>\n        </div>")).not.toMatch(/<svg\b/);
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
    expect(read("public/js/core/copy.js")).toMatch(/id: "disconnect", label: "Disconnect OneDrive"/);
    const route = between(read("src/worker/routes/auth.ts"), /"\/api\/me\/disconnect"/, "),\n  ),");
    expect(route).toMatch(/vault\.delete\(userId\)/);
    expect(route).toMatch(/sessions\.destroyAll\(userId\)/);
    // One pair of sentences for the same claim on both pages.
    const access =
      /Once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop ?deletes its stored access and every sign-in ends at once, a lost phone's included\. You may also be able to remove bloop ?in My Apps \(myapplications\.microsoft\.com\); your IT team can remove it for everyone in Microsoft Entra\./;
    expect(text).toMatch(access);
    expect(visibleText(read("public/privacy.html"))).toMatch(access);
    // Removing Access holds every removal step, the lost phone's included; the Threat Model only points to it.
    const remove = visibleText(between(read("public/security.html"), /<h2 id="remove">/, "</section>"));
    expect(remove).toMatch(/^Removing Access /);
    // One sentence covers a lost phone, so the card says it once.
    expect(remove).toMatch(/a lost phone's included\./);
    expect(remove).not.toMatch(/Lost phone:/);
    const threats = visibleText(between(read("public/security.html"), /<h2 id="threats">/, "</section>"));
    expect(threats).toMatch(/Lost phone: see Removing Access ?\.$/);
    expect(threats).not.toMatch(/Disconnect|My Apps|Entra/);
    expect(read("public/security.html")).toContain('<a href="#remove">Removing Access</a>');
    // Admin consent can keep a user from removing the app, so My Apps is never promised.
    for (const page of ["security.html", "privacy.html"]) {
      expect(visibleText(read(`public/${page}`)), page).not.toMatch(/You can (also )?remove bloop ?in My Apps/);
    }
    // My Apps and Entra end only the refresh token; bloop's own sessions stay, so neither is said to sign anyone out.
    for (const page of ["security.html", "privacy.html"]) {
      expect(visibleText(read(`public/${page}`)), page).not.toMatch(/(My Apps|Entra)[^.]*sign(s|ed)? (you )?out/);
    }
    expect(text).toContain("after 90 minutes, or 60 in the demo");
  });
});

describe("privacy notice", () => {
  it("keeps the OneDrive grant only as the code does: until disconnect, a failed refresh after removal, or 30 days unused", () => {
    const row = between(read("public/privacy.html"), /<tr><th scope="row">Your OneDrive access/, "</tr>");
    expect(row).toContain(
      'Until you disconnect (deleted at once) or remove <b class="name">bloop</b> in My Apps or Entra (deleted the next time it fails), or 30 days unused.',
    );
    expect(read("docs/threat-model.md")).toMatch(
      /\| refresh token \(grant\) \| D1 \| until disconnect \(at once, with every phone session\)/,
    );
  });

  it("states what the waitlist keeps, why and for how long", () => {
    const row = between(read("public/privacy.html"), /<tr><th scope="row">Waitlist/, "</tr>");
    expect(row).toMatch(/email and answers/);
    expect(row).toMatch(/to invite you/);
    expect(row).toMatch(/until you ask/);
  });
});
