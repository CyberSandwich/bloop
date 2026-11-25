// Content rules and the CLI of the page build (tools/build-pages.mjs, design.md section 6, Site build).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadDocs, renderDoc } from "../../tools/build-pages.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const docs = loadDocs();

function render(body: string, meta: Record<string, string | boolean> = {}) {
  const doc = {
    file: "content/x.md",
    path: "/x",
    out: "public/x.html",
    slug: "x",
    dir: "",
    meta: { kind: "article", title: "X Title", description: "A page.", published: "2026-11-25", ...meta },
    body,
  };
  return renderDoc(doc, [...docs, doc]);
}
const SECTION = "Summary.\n\n## One {#one}\n\n";

describe("content the build refuses", () => {
  it("an image", () => {
    expect(() => render(`${SECTION}![alt](/a.png)\n`)).toThrow(/images are not supported/);
  });

  it("raw HTML", () => {
    expect(() => render(`${SECTION}Text <b>x</b> here.\n`)).toThrow(/raw HTML/);
  });

  it("markup in a heading", () => {
    expect(() => render(`${SECTION}### A [link](/a)\n`)).toThrow(/heading is plain text/);
    expect(() => render("Summary.\n\n## One **bold** {#one}\n\nText.\n")).toThrow(/heading is plain text/);
  });

  it("markup in a caption or a column head", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    expect(() => render(`${SECTION}Caption: See [here](/a).\n\n${table}`)).toThrow(/caption is plain text/);
    expect(() => render(`${SECTION}Caption: Two.\n\n| **A** | B |\n|---|---|\n| 1 | 2 |\n`)).toThrow(
      /column head is plain text/,
    );
  });

  it("a caption with no table, or two captions in a row", () => {
    expect(() => render(`${SECTION}Caption: Lonely.\n`)).toThrow(/no table after it/);
    expect(() => render(`${SECTION}Caption: One.\n\nCaption: Two.\n`)).toThrow(/two "Caption:"/);
  });

  it("a nested list", () => {
    expect(() => render(`${SECTION}- a\n  - b\n`)).toThrow(/nested lists/);
  });

  it("sections in an index, which lists its articles itself", () => {
    expect(() => render(`${SECTION}Text.\n`, { kind: "index" })).toThrow(/an index lists its articles/);
  });

  it("an id that appears twice on a page", () => {
    expect(() => render("Summary.\n\n## One {#one}\n\nText.\n\n## Two {#one}\n\nText.\n")).toThrow(/appears twice/);
  });
});

describe("text from markdown", () => {
  it("keeps an entity the author wrote and escapes a bare ampersand", () => {
    const html = render(`${SECTION}Fish &amp; chips, R&D, 5&nbsp;min.\n`);
    expect(html).toContain("Fish &amp; chips, R&amp;D, 5&nbsp;min.");
    expect(html).not.toContain("&amp;amp;");
  });
});

describe("version counting on a legal page", () => {
  const legal = (changes: string) =>
    render(`Summary.\n\n## What Changed {#changes}\n\n${changes}\n`, {
      kind: "legal",
      effective: "2026-11-25",
      version: "1.0",
    });

  it("counts Version bullets, not the text of a paragraph that mentions one", () => {
    expect(legal("- Version 1.0, 2026-11-25: first.\n- Earlier drafts never took effect.")).toContain(
      ">No previous versions</a>",
    );
    expect(legal("- Version 1.1, 2026-12-01: x.\n- Version 1.0, 2026-11-25: first.")).toContain(
      ">Previous versions</a>",
    );
  });
});

describe("the CLI", { timeout: SPAWN_TIMEOUT }, () => {
  let copy = "";
  afterEach(() => rmSync(copy, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(REPO, "tools/build-pages-cli.mjs"), ...args], {
      env: { ...process.env, BUILD_PAGES_ROOT: `${copy}/` },
      encoding: "utf8",
    });
  const setup = () => {
    copy = mkdtempSync(join(tmpdir(), "build-pages-"));
    for (const dir of ["content", "tools/pages", "public"])
      cpSync(join(REPO, dir), join(copy, dir), { recursive: true });
  };

  it("--check passes on a clean copy and writes nothing", () => {
    setup();
    expect(run("--check").status).toBe(0);
  });

  it("--check fails on a drifted page and leaves it alone; a build repairs it", () => {
    setup();
    writeFileSync(join(copy, "public/privacy.html"), "drift");
    const check = run("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("public/privacy.html");
    expect(run().status).toBe(0);
    expect(run("--check").status).toBe(0);
  });

  it("a generated page whose content file is gone is reported by --check and deleted by a build", () => {
    setup();
    rmSync(join(copy, "content/articles/data-and-retention.md"));
    const check = run("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("public/articles/data-and-retention.html (no content file builds it)");
    expect(existsSync(join(copy, "public/articles/data-and-retention.html"))).toBe(true);
    run();
    expect(existsSync(join(copy, "public/articles/data-and-retention.html"))).toBe(false);
  });
});
