import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { EXTENSION_TYPES } from "../../public/js/shared/names.js";
import { contrast, luminance, type Rgb, token } from "./contrast.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../public/${rel}`, import.meta.url)), "utf8");
const PAGES = ["s.html", "a.html", "code.html"] as const;

describe.each(PAGES)("%s under the strict CSP", (page) => {
  const html = read(page);

  it("has no inline script, inline style, style attribute or event handler", () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("loads only same-origin scripts and styles", () => {
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1] as string;
      if (url.startsWith("https://tally.so/r/")) continue; // the Waitlist link: a navigation, not a load
      expect(url.startsWith("http"), url).toBe(false);
    }
  });

  it("is US English, noindex, light only", () => {
    expect(html).toContain('lang="en-US"');
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('name="color-scheme" content="light"');
  });

  it("has a skip link first, one h1, and a no-JavaScript message", () => {
    expect(html).toMatch(/<body[^>]*>\s*<a class="skip"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("<noscript>");
  });

  it("uses none of the banned characters in its text", () => {
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/[–—!]/);
  });
});

describe("client code under the strict CSP", () => {
  const files = [
    "screen.js",
    "viewer.js",
    "phone.js",
    "code.js",
    "core/demo.js",
    "core/rows.js",
    "core/ui.js",
    "core/channel.js",
    "core/api.js",
    "core/boot-code.js",
  ];

  it.each(files)("%s never uses eval, innerHTML or script URLs (trusted types are off)", (file) => {
    const code = read(`js/${file}`);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/new Function\s*\(/);
    expect(code).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/setTimeout\(\s*["'`]/);
  });

  it('never toggles an ARIA state, which would write the empty value that reads as false (aria-invalid="")', () => {
    const dir = fileURLToPath(new URL("../../public/js/", import.meta.url));
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".js") && !f.startsWith("vendor"),
    );
    expect(sources).toContain("code.js");
    for (const file of sources) expect(read(`js/${file}`), file).not.toMatch(/toggleAttribute\(\s*["'`]aria-/);
  });

  it("never puts a credential in a URL", () => {
    for (const file of ["screen.js", "viewer.js", "phone.js", "core/channel.js"]) {
      const code = read(`js/${file}`);
      expect(code, file).not.toMatch(/[?&](sid|pid)=/);
    }
  });

  it("the phone page strips the code from the address when its modules load, before it makes a request", () => {
    const phone = read("js/phone.js");
    expect(phone).toMatch(/import \{ bootCode \} from "\.\/core\/boot-code\.js"/);
    expect(read("js/core/boot-code.js")).toContain('history.replaceState(null, "", location.pathname)');
    // Modules only define things; the one top-level call that starts a request is `start()` at the end.
    expect(phone.trimEnd().endsWith("start();")).toBe(true);
    expect(phone.match(/^(?:await )?(?:api|fetch)\b/gm)).toBeNull();
  });
});

describe("the screen and phone pages restored from the back-forward cache", () => {
  it("reloads, so a page whose socket or leave is gone never shows a stale state; a plain load never loops", () => {
    // The handler as both pages register it, run against a fake location.
    for (const page of ["js/screen.js", "js/phone.js"]) expect(read(page), page).toContain("reloadOnRestore();");
    const src = read("js/core/ui.js").match(/addEventListener\("pageshow", (\(e\) => [^\n]+)\);/)?.[1];
    expect(src).toBeDefined();
    const reload = vi.fn();
    const handler = new Function("location", `return ${src}`)({ reload }) as (e: { persisted: boolean }) => void;
    handler({ persisted: false });
    expect(reload).not.toHaveBeenCalled();
    handler({ persisted: true });
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("the phone's file picker", () => {
  const accept = (/accept="([^"]+)"/.exec(read("a.html"))?.[1] ?? "").split(",");

  it("offers photos, videos, decks and PDFs, so iOS lists Photo Library, Take Photo and Choose File", () => {
    for (const entry of [
      "image/jpeg",
      "image/png",
      "video/mp4",
      "video/quicktime",
      ".jpg",
      ".jpeg",
      ".png",
      ".mp4",
      ".mov",
      ".pdf",
      ".pptx",
    ]) {
      expect(accept, entry).toContain(entry);
    }
  });

  it("lists exactly the extensions a guest may send (shared/names.js), so desktop's file explorer offers no other", () => {
    const extensions = accept.filter((a) => a.startsWith(".")).sort();
    expect(extensions).toEqual(
      Object.keys(EXTENSION_TYPES)
        .map((e) => `.${e}`)
        .sort(),
    );
  });

  it("never lists HEIC (iOS then hands over a JPEG) and has no capture attribute (it would skip the library)", () => {
    expect(accept.join()).not.toMatch(/hei[cf]/i);
    expect(read("a.html")).not.toMatch(/\scapture[=\s>]/);
  });

  it("has the drop hint, hidden until a file is dragged over, and not announced", () => {
    expect(read("a.html")).toMatch(/<div class="drop-hint" id="drop-hint" aria-hidden="true" hidden>/);
  });
});

describe("the phone's band", () => {
  it("each band query is written once, and the on-page query is its complement", () => {
    const preludes = [...read("css/app.css").matchAll(/@media ([^{]*599\.98px[^{]*)\{/g)].map((m) => m[1]?.trim());
    expect(preludes.filter((q) => q?.startsWith("(max-width: 639.98px)"))).toEqual([
      "(max-width: 639.98px), (max-height: 599.98px) and (max-width: 899.98px)",
    ]);
    expect(
      read("css/app.css").match(/@media \(min-width: 640px\) and \(min-height: 600px\), \(min-width: 900px\) \{/g),
    ).toHaveLength(1);
  });
});

describe("secondary text on every neutral it sits on (design.md section 12)", () => {
  const glass = token("glass", "paper");
  const grounds: [string, Rgb][] = [
    ["paper", token("paper")],
    ["the hover wash on paper", token("wash", "paper")],
    ["glass over paper", glass],
    ["the hover wash on glass", token("wash", glass)],
    ["a selected row", token("g-select")],
  ];

  it.each(grounds)("--muted clears 4.6:1 on %s", (_, ground) => {
    expect(contrast(token("muted"), ground)).toBeGreaterThanOrEqual(4.6);
  });

  it("a selected row is filled with --g-select, and a lead is never lighter than --muted", () => {
    expect(read("css/app.css")).toMatch(/\.item\[aria-current\] \{\n {2}background: var\(--g-select\);/);
    expect(luminance(token("lead"))).toBeLessThanOrEqual(luminance(token("muted")));
  });
});

describe("the screen before its first paint", () => {
  it("hides the bar and footer only once the script has run past the framed and narrow exits", () => {
    expect(read("css/app.css")).toMatch(/\n\.is-booting:not\(\.is-ready\) :is\(\.bar > \*, \.foot\) \{/);
    expect(read("css/app.css")).not.toMatch(/\.page-screen:not\(\.is-ready\)/);
    const start = read("js/screen.js").match(/function start\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const at = (s: string) => start.indexOf(s);
    expect(at('classList.add("is-booting")')).toBeGreaterThan(at("if (isFramed()) return;"));
    expect(at('classList.add("is-booting")')).toBeGreaterThan(at("matches) return;"));
    expect(at("if (isFramed()) return;")).toBeGreaterThanOrEqual(0);
    expect(at("matches) return;")).toBeGreaterThanOrEqual(0);
  });
});

describe("the demo screen", () => {
  it("hides the live footer line, which sends the visitor to a PC sign-in they do not have", () => {
    expect(read("s.html")).toMatch(/<p class="foot" id="foot">Phone not with you\?/);
    expect(read("js/screen.js")).toContain('document.body.classList.add("is-demo")');
    expect(read("css/app.css")).toMatch(/\.is-demo > \.foot \{\s*display: none;\s*\}/);
  });

  it("the waitlist link opens the form with source=viewer, in the same tab, and carries data-waitlist", () => {
    const link = read("s.html").match(/<a\b[^>]*\bdata-waitlist\b[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="https://tally.so/r/Yj4KAN?source=viewer"');
    expect(link).not.toContain("target=");
  });

  it("LINK-01 a link item opens in a new tab with no opener or referrer, and is never framed", () => {
    const viewer = read("js/viewer.js");
    expect(viewer).toMatch(/target: "_blank", rel: "noopener noreferrer"/);
    expect(viewer).toContain('startsWith("https://")');
    for (const file of ["js/viewer.js", "js/screen.js", "s.html"]) expect(read(file), file).not.toMatch(/iframe/i);
  });

  it("one labeled Back pill in the house frame, first in the corner bar of every app page; no logo on the phone pages", () => {
    for (const page of ["s.html", "a.html", "code.html"]) {
      const html = read(page);
      expect(html, page).toMatch(
        /<header class="bar">\s*<a class="framed"[^>]* href="\/"><svg[\s\S]*?<\/svg>Back<\/a>/,
      );
    }
    for (const page of ["a.html", "code.html"])
      expect(read(page), page).not.toMatch(/class="brand"|favicon\.svg" width/);
  });

  it("icons are Lucide as inlined: one 2 px stroke, round caps and joins, in the pages and in ui.js", () => {
    for (const page of ["s.html", "a.html", "code.html"]) {
      const icons = read(page).match(/<svg class="icon"[^>]*>/g) ?? [];
      expect(icons.length, page).toBeGreaterThan(0);
      for (const svg of icons) {
        expect(svg, page).toContain('stroke-width="2"');
        expect(svg, page).toContain('stroke-linecap="round" stroke-linejoin="round"');
      }
      expect(read(page), page).not.toContain('stroke-width="1.5"');
    }
    expect(read("js/core/ui.js")).toContain('"stroke-width": "2"');
    expect(read("js/core/icons.js")).toContain("Lucide");
  });
});

describe("the font", () => {
  it("ships its license beside the file", () => {
    expect(read("fonts/Inter.LICENSE.txt")).toContain("SIL OPEN FONT LICENSE");
  });
});
