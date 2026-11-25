// The HTML comment strip (tools/build-assets.mjs, ADR 0011): shipped pages carry no comment, raw text is untouched.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build, stripComments } from "../../tools/build-assets.mjs";

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const strip = (html: string) => stripComments(html, "x.html");

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stripComments", () => {
  it("removes a comment and the line it leaves empty", () => {
    expect(strip("<p>a</p>\n  <!-- build:nav -->\n<p>b</p>\n")).toBe("<p>a</p>\n<p>b</p>\n");
    expect(strip("<!-- one\n  two -->\n<p>b</p>")).toBe("<p>b</p>");
  });

  it("keeps the rest of a line a comment shares", () => {
    expect(strip("<p>a</p> <!-- x -->")).toBe("<p>a</p> ");
    expect(strip("<b>a</b><!-- x --><i>b</i>")).toBe("<b>a</b><i>b</i>");
  });

  it("raw text is never touched: script, style, textarea and title are byte-identical", () => {
    const raw = [
      '<script type="application/ld+json">{"a":"<!-- x -->"}</script>',
      "<style>/* <!-- y --> */</style>",
      "<textarea><!-- z --></textarea>",
      "<title>a <!-- w --></title>",
      "<SCRIPT>var s = '<!-- v -->';</SCRIPT>",
    ].join("\n");
    expect(strip(`<!-- gone -->\n${raw}\n<!-- gone -->\n`)).toBe(`${raw}\n`);
  });

  it("only comments are removed: the output is the input minus the comment spans and the lines they emptied", () => {
    const parts = ["<h1>A</h1>", "<p>b <em>c</em></p>", '<a href="/x?a=1&amp;b=2">d</a>'];
    const input = `${parts[0]}\n<!-- 1 -->\n${parts[1]}\n    <!-- 2 -->\n${parts[2]}<!-- 3 -->\n`;
    expect(strip(input)).toBe(`${parts[0]}\n${parts[1]}\n${parts[2]}\n`);
  });

  it("is idempotent", () => {
    const once = strip("<p>a</p>\n<!-- x -->\n<p>b</p> <!-- y -->\n");
    expect(strip(once)).toBe(once);
  });

  it("a comment text mentioning < or -- is still one comment", () => {
    expect(strip("<p>a</p><!-- a < b -- c --><p>b</p>")).toBe("<p>a</p><p>b</p>");
  });

  it.each([
    ["<p></p><!-->", "empty comment"],
    ["<p></p><!--->", "empty comment"],
    ["<p></p><!-- a --!> b -->", "--!>"],
    ["<p></p><!-- a <!-- b -->", "nested"],
    ["<p></p><!-- a", "unterminated comment"],
    ["<pre>a<!-- x -->b</pre>", "<pre>"],
    ["<script>a", "unterminated <script>"],
    ['<a title="x <!-- y --> z">k</a>', "comment inside a <a> tag"],
    ["<meta content='<!-- y -->'>", "comment inside a <meta> tag"],
    ['<a title="x', "unterminated <a> tag"],
  ])("odd input fails the build: %s", (html, why) => {
    expect(() => strip(html)).toThrow(why);
  });

  it("a comment after a closed <pre> is fine", () => {
    expect(strip("<pre>a</pre><!-- x --><p>b</p>")).toBe("<pre>a</pre><p>b</p>");
  });
});

describe("shipped pages", () => {
  const pages = readdirSync(PUBLIC, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".html"))
    .map((d) => join(d.parentPath, d.name));

  it("no shipped page carries a comment", () => {
    expect(pages.length).toBeGreaterThan(5);
    for (const path of pages) {
      const text = stripComments(readFileSync(path, "utf8"), path);
      // What is left may hold `<!--` only inside raw text.
      const outside = text.replace(/<(script|style|textarea|title)\b[\s\S]*?<\/\1\s*>/gi, "");
      expect(outside, path).not.toContain("<!--");
    }
  });

  it("build() writes stripped HTML to dist and leaves public alone", () => {
    root = mkdtempSync(join(tmpdir(), "html-comments-"));
    const page = "<p>a</p>\n<!-- gone -->\n<p>b</p>\n";
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "public/p.html"), page);
    mkdirSync(dirname(join(root, "public/n/q.txt")), { recursive: true });
    writeFileSync(join(root, "public/n/q.txt"), "<!-- kept: not html -->");
    build(root);
    expect(readFileSync(join(root, "dist/p.html"), "utf8")).toBe("<p>a</p>\n<p>b</p>\n");
    expect(readFileSync(join(root, "dist/n/q.txt"), "utf8")).toBe("<!-- kept: not html -->");
    expect(readFileSync(join(root, "public/p.html"), "utf8")).toBe(page);
  });
});
