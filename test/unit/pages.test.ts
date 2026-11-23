import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
    "screen-demo.js",
    "phone.js",
    "code.js",
    "core/demo.js",
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
    for (const file of ["screen.js", "screen-demo.js", "phone.js", "core/channel.js"]) {
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

describe("the font", () => {
  it("ships its license beside the file", () => {
    expect(read("fonts/Inter.LICENSE.txt")).toContain("SIL OPEN FONT LICENSE");
  });
});
