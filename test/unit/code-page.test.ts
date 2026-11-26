import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = join(import.meta.dirname, "../../public");
const read = (p: string) => readFileSync(join(PUBLIC, p), "utf8");

describe("/code page", () => {
  const html = read("code.html");
  const js = read("js/code.js");

  it("shows no Code label: the field is named by the heading", () => {
    expect(html).not.toContain("<label");
    expect(html).toMatch(/<input class="field" id="code"[^>]*aria-labelledby="title"/);
    expect(read("css/app.css")).not.toContain(".field-label");
  });

  it("has a Paste button named by aria-label, drawn with Lucide's clipboard-paste", () => {
    const button = html.match(/<button[^>]*id="paste"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain('aria-label="Paste"');
    expect(button).toContain('type="button"');
    expect(button).toContain('<path d="M11 14h10"/>');
    // Hidden until the script finds readText: without the script it would do nothing.
    expect(button.match(/<button[^>]*>/)?.[0]).toContain(" hidden>");
  });

  it("hides Paste by feature detection and fills through check(), the typed path, with no submit", () => {
    expect(js).toContain("paste.hidden = !navigator.clipboard?.readText");
    const handler = js.match(/paste\.addEventListener\("click"[\s\S]*?\n\}\);/)?.[0] ?? "";
    expect(handler).toContain("navigator.clipboard.readText()");
    expect(handler).toMatch(/\n {2}check\(\);\n/);
    expect(handler).not.toMatch(/typedCode|submit|requestSubmit|\.click\(/);
    expect(js.match(/typedCode\(/g)).toHaveLength(1);
  });
});
