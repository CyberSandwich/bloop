// The page build's two modes (tools/build-pages.mjs, ADR 0026): preview is today's site, open adds its own variant of
// each page under public/open/, and the two are kept from leaking into each other (MODE-01).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAll,
  docsFor,
  faqOf,
  navHtml,
  openVariant,
  PLACEHOLDER_DATE,
  parseSite,
  placeholderDates,
  site,
  siteFor,
} from "../../tools/build-pages.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const preview = buildAll();
const open = buildAll("open");
const under = (rel: string) => rel.replace(/^public\/open\//, "public/");

describe("two modes emit the same relative paths, plus the open-only pages", () => {
  it("the open file set equals the preview set under public/open/, plus the Features article", () => {
    // `_launch.json` is the one file with no open copy: it is about the open site, not a page of it.
    const pages = [...preview.keys()].filter((rel) => rel !== "public/_launch.json");
    expect([...open.keys()].map(under).sort()).toEqual([...pages, "public/articles/features.html"].sort());
    for (const rel of open.keys()) expect(rel.startsWith("public/open/"), rel).toBe(true);
  });

  it("open docs overlay base docs at the same path, and add the paths the base lacks", () => {
    const base = docsFor("preview");
    const merged = docsFor("open");
    expect(merged.find((d) => d.path === "/privacy")?.file).toBe("content/open/privacy.md");
    expect(merged.find((d) => d.path === "/accessibility")?.file).toBe("content/accessibility.md");
    expect(merged.find((d) => d.path === "/articles/features")?.file).toBe("content/open/articles/features.md");
    expect(base.some((d) => d.path === "/articles/features")).toBe(false);
    expect(merged.every((d) => d.out.startsWith("public/open/") && d.mode === "open")).toBe(true);
  });

  it("the open sitemap and llms.txt name Features and Security as articles, preview's name Features nowhere", () => {
    expect(open.get("public/open/sitemap.xml")).toContain("<loc>https://bloop.here/articles/features</loc>");
    expect(open.get("public/open/llms.txt")).toContain("[Features](https://bloop.here/articles/features)");
    for (const rel of ["public/sitemap.xml", "public/llms.txt"])
      expect(preview.get(rel), rel).not.toContain("features");
    expect(open.get("public/open/robots.txt")).toBe(preview.get("public/robots.txt"));
  });

  it("MODE-01 preview sitemap and llms name no open-only path", () => {
    const openOnly = [...open.keys()].map(under).filter((rel) => !preview.has(rel));
    expect(openOnly).toEqual(["public/articles/features.html"]);
    for (const rel of ["public/sitemap.xml", "public/llms.txt"])
      expect(preview.get(rel), rel).not.toContain("/articles/features");
  });

  it("the open Articles index lists Features and Security; preview's lists neither", () => {
    const list = (html: string) => [...html.matchAll(/<a href="(\/[^"]+)">Read the Article<\/a>/g)].map((m) => m[1]);
    expect(list(open.get("public/open/articles.html") ?? "")).toEqual([
      "/articles/features",
      "/articles/how-bloop-works",
      "/articles/threat-model-for-it-teams",
      "/articles/what-stays-on-the-pc",
      "/articles/data-and-retention",
      "/security",
    ]);
    expect(list(preview.get("public/articles.html") ?? "")).not.toContain("/security");
  });
});

describe("the chrome by mode", () => {
  it("preview's nav is the Waitlist pill with the page's source, open's is the account pill and no Waitlist", () => {
    const head = { file: "x.html", title: "t", source: "landing", kind: "none" as const };
    expect(navHtml(head)).toContain(
      '<a class="btn waitlist" href="https://tally.so/r/Yj4KAN?source=landing" data-waitlist>Waitlist</a>',
    );
    const nav = navHtml({ ...head, mode: "open" });
    expect(nav).toContain('<a class="btn account" href="/signin" data-account>Sign In</a>');
    expect(nav).not.toContain("waitlist");
  });

  it("site.open overrides only links and about; any other key throws", () => {
    const json = (open: object) => JSON.stringify({ ...site, open });
    expect(parseSite(json({ links: [], about: "x" })).open).toEqual({ links: [], about: "x" });
    expect(() => parseSite(json({ email: "other@bloop.here" }))).toThrow(/open\.email is not a mode difference/);
    expect(siteFor("preview")).toBe(site);
    expect(siteFor("open").links).not.toEqual(site.links);
    expect(siteFor("open").origin).toBe(site.origin);
  });
});

describe("a hand page's open variant", () => {
  const page =
    "<main>\n  <!-- mode:a -->\n  <p>one</p>\n  <!-- /mode:a -->\n\n  <!-- mode:b -->\n  <p>two</p>\n  <!-- /mode:b -->\n</main>\n";
  const over = "<!-- mode:a -->\n<p>ONE</p>\n<!-- /mode:a -->\n\n<!-- mode:b -->\n<!-- /mode:b -->\n";

  it("replaces each region by the same-named one, at its indent, and drops an empty region with its blank line", () => {
    expect(openVariant(page, over, "x")).toBe("<main>\n  <p>ONE</p>\n\n</main>\n");
  });

  it("a mode region missing on either side throws", () => {
    expect(() => openVariant(page, "<!-- mode:a -->\n<p>x</p>\n<!-- /mode:a -->\n", "x")).toThrow(/no mode:b region/);
    expect(() => openVariant(page, `${over}<!-- mode:c -->\n<!-- /mode:c -->\n`, "x")).toThrow(
      /no mode:c region in the page/,
    );
    expect(() => openVariant(page, undefined, "x")).toThrow(/no mode:a region/);
  });

  it("a mode marker that is unclosed or mistyped throws", () => {
    expect(() => openVariant(`${page}<!-- mode:z -->\n`, over, "x")).toThrow(/unmatched or malformed/);
    expect(() => openVariant(`${page}<!-- /mode:z -->\n`, over, "x")).toThrow(/unmatched or malformed/);
  });

  it("an override for a page with no regions throws, and a page with none and no override is fine", () => {
    expect(() => openVariant("<p>x</p>\n", over, "x")).toThrow(/page with no mode regions/);
    expect(openVariant("<p>x</p>\n", undefined, "x")).toBe("<p>x</p>\n");
  });

  it("faqOf reads the variant it renders: the open landing's structured data says what the open FAQ says", () => {
    const html = open.get("public/open/index.html") ?? "";
    const visible = faqOf(html, "open/index.html");
    expect(visible.find((q) => q.q === "Which files work?")?.a).toBe(
      "Slides, documents, PDFs, spreadsheets, photos, videos and links.",
    );
    expect(html).toContain(JSON.stringify("Slides, documents, PDFs, spreadsheets, photos, videos and links."));
    expect(preview.get("public/index.html")).toContain("PowerPoint, PDF, photos, videos and links.");
  });

  it("a generated open page names its sources, and the markers of the mode regions are gone", () => {
    const html = open.get("public/open/index.html") ?? "";
    expect(
      html.startsWith(
        "<!DOCTYPE html>\n<!-- GENERATED by tools/build-pages.mjs from public/index.html and tools/pages/open/index.html.",
      ),
    ).toBe(true);
    expect(html).not.toMatch(/mode:/);
    expect(open.get("public/open/404.html")).toContain("from public/404.html. Edit that file");
    expect(open.get("public/open/privacy.html")).toContain("from content/open/privacy.md.");
  });
});

describe("the CLI builds both modes and removes a stale open page", () => {
  let copy = "";
  afterEach(() => rmSync(copy, { recursive: true, force: true }));

  it("a deleted content/open article is removed from public/open, and --check reports it first", async () => {
    copy = mkdtempSync(join(tmpdir(), "build-pages-modes-"));
    for (const dir of ["content", "tools/pages", "public"]) {
      mkdirSync(join(copy, dir), { recursive: true });
      cpSync(join(REPO, dir), join(copy, dir), { recursive: true });
    }
    writeFileSync(
      join(copy, "content/open/articles/x.md"),
      "---\nkind: article\norder: 9\ntitle: X\ndescription: A page for the stale check.\npublished: 2026-11-25\n---\n\nSummary.\n\n## One {#one}\n\nText.\n",
    );
    const { spawnSync } = await import("node:child_process");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(REPO, "tools/build-pages-cli.mjs"), ...args], {
        env: { ...process.env, BUILD_PAGES_ROOT: `${copy}/` },
        encoding: "utf8",
      });
    expect(run().status).toBe(0);
    expect(existsSync(join(copy, "public/open/articles/x.html"))).toBe(true);
    expect(readFileSync(join(copy, "public/open/sitemap.xml"), "utf8")).toContain("/articles/x");
    rmSync(join(copy, "content/open/articles/x.md"));
    const check = run("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("public/open/articles/x.html (no content file builds it)");
    expect(run().status).toBe(0);
    expect(existsSync(join(copy, "public/open/articles/x.html"))).toBe(false);
  }, 60_000);
});

describe("one source for the form URL and the launch dates", () => {
  it("the open landing and Features take the waitlist URL from site.json, with no literal of their own", () => {
    expect(open.get("public/open/index.html")).toContain(`href="${site.waitlist}?source=landing-end"`);
    expect(open.get("public/open/articles/features.html")).toContain(`href="${site.waitlist}?source=features"`);
    for (const rel of ["tools/pages/open/index.html", "content/open/articles/features.md"]) {
      expect(readFileSync(join(REPO, rel), "utf8"), rel).not.toContain(site.waitlist);
    }
  });

  it("the launch gate lists exactly the open documents still dated with the placeholder", () => {
    const listed = placeholderDates();
    const dated = docsFor("open")
      .flatMap((d) => ["published", "effective", "updated"].map((key) => [d, key] as const))
      .filter(([d, key]) => d.meta[key] === PLACEHOLDER_DATE)
      .map(([d, key]) => `${d.file}: ${key}`);
    expect(listed).toEqual(dated);
  });
});

describe("launchReady: the manifest the admin switch reads, and the CLI, say the same", () => {
  let copy = "";
  afterEach(() => rmSync(copy, { recursive: true, force: true }));

  const stage = () => {
    copy = mkdtempSync(join(tmpdir(), "build-pages-launch-"));
    for (const dir of ["content", "tools/pages", "public"]) {
      mkdirSync(join(copy, dir), { recursive: true });
      cpSync(join(REPO, dir), join(copy, dir), { recursive: true });
    }
  };
  const cli = async (...args: string[]) => {
    const { spawnSync } = await import("node:child_process");
    return spawnSync(process.execPath, [join(REPO, "tools/build-pages-cli.mjs"), ...args], {
      env: { ...process.env, BUILD_PAGES_ROOT: `${copy}/` },
      encoding: "utf8",
    });
  };
  const manifest = () => JSON.parse(readFileSync(join(copy, "public/_launch.json"), "utf8"));

  it("the committed manifest is the build's, and it lists exactly what placeholderDates() lists", () => {
    expect(preview.get("public/_launch.json")).toBe(readFileSync(join(REPO, "public/_launch.json"), "utf8"));
    const m = JSON.parse(preview.get("public/_launch.json") ?? "{}");
    expect(m.placeholder).toEqual(placeholderDates());
    expect(m.launchReady).toBe(m.placeholder.length === 0);
  });

  it("false while a document is on the placeholder date, true once every date is stamped, and the CLI follows", async () => {
    stage();
    expect((await cli()).status).toBe(0);
    expect(manifest().launchReady).toBe(false);
    expect((await cli("--launch")).status).toBe(1);
    for (const file of manifest().placeholder.map((p: string) => p.split(": ")[0])) {
      const path = join(copy, file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(PLACEHOLDER_DATE, "2026-12-01"));
    }
    expect((await cli()).status).toBe(0);
    expect(manifest()).toEqual({ launchReady: true, placeholder: [] });
    expect((await cli("--launch")).status).toBe(0);
  }, 60_000);
});
