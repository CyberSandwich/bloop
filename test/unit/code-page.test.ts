import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(import.meta.dirname, "../../public/code.html"), "utf8");

describe("/code page markup", () => {
  it("shows no Code label: the field is named by the heading", () => {
    expect(html).not.toContain("<label");
    expect(html).toMatch(/<input class="field" id="code"[^>]*aria-labelledby="title"/);
  });

  it("has a Paste button named by aria-label, drawn with Lucide's clipboard-paste, hidden until the script finds readText", () => {
    const button = html.match(/<button[^>]*id="paste"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain('aria-label="Paste"');
    expect(button).toContain('type="button"');
    expect(button).toContain('<path d="M11 14h10"/>');
    expect(button.match(/<button[^>]*>/)?.[0]).toContain(" hidden>");
  });
});
