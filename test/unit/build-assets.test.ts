// The served build (tools/build-assets.mjs, ADR 0011): public/ copied to dist/ with each JS module minified alone.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  build,
  immutableUnits,
  importClosure,
  minify,
  minifyCss,
  staleUnits,
  unitHash,
  withModulePreload,
} from "../../tools/build-assets.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function project(files: Record<string, string | Buffer>) {
  root = mkdtempSync(join(tmpdir(), "build-assets-"));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "public", rel)), { recursive: true });
    writeFileSync(join(root, "public", rel), data);
  }
}
const out = (rel: string) => readFileSync(join(root, "dist", rel));

/** What a module exports and imports, statically and by import(), read by esbuild without bundling. */
async function shape(code: string) {
  const { metafile } = await esbuild({
    stdin: { contents: code, loader: "js", sourcefile: "m.js" },
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    // A bundle with every specifier external: the metafile lists each import and export, and no file is resolved.
    plugins: [
      { name: "external", setup: (b) => b.onResolve({ filter: /.*/ }, (a) => ({ path: a.path, external: true })) },
    ],
    bundle: true,
  });
  const output = Object.values(metafile.outputs)[0];
  return {
    exports: [...(output?.exports ?? [])].sort(),
    imports: (output?.imports ?? []).map((i) => `${i.kind} ${i.path}`).sort(),
  };
}

describe("build", () => {
  const JS = [
    "// A comment no user should download.",
    'import { helper } from "./lazy-helper.js";',
    "/** A doc comment. */",
    "export const longExportedName = (value) => helper(value) + 1;",
    'export const later = () => import("./lazy.js");',
  ].join("\n");

  it("minifies each module alone: comments gone, export names and import() specifiers kept", async () => {
    project({
      "js/a.js": JS,
      "js/lazy.js": "export const z = 1;\n",
      "js/lazy-helper.js": "export const helper = (v) => v * 2;\n",
    });
    build(root);
    const code = out("js/a.js").toString();
    expect(code).not.toContain("comment");
    expect(code.length).toBeLessThan(JS.length);
    expect(code).toContain('import("./lazy.js")');
    expect(code).toContain('from"./lazy-helper.js"');
    // It still runs as a module, with the same exports.
    const mod = await import(pathToFileURL(join(root, "dist/js/a.js")).href);
    expect(mod.longExportedName(2)).toBe(5);
    expect(await mod.later()).toMatchObject({ z: 1 });
  });

  it("strips a stylesheet's comments and whitespace and keeps same-body rules apart", () => {
    // A syntax minifier would print `.b>.c,.d{color:red}`.
    const CSS =
      "/* gone */\n.a:not(:popover-open) {\n  color: red;\n}\n\n.b > .c {\n  color: red;\n}\n.d { color: red; }\n";
    project({ "css/a.css": CSS });
    build(root);
    expect(out("css/a.css").toString()).toBe(".a:not(:popover-open){color:red}.b>.c{color:red}.d{color:red}\n");
  });

  it("copies every other file byte for byte, dotfiles included", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    project({
      "robots.txt": "# kept\nUser-agent: *\n",
      "index.html": '<!doctype html><script type="module" src="/js/a.js"></script>\n',
      ".assetsignore": "*.d.ts\n",
      "img/x.png": png,
      "js/types.d.ts": "export type T = 1;\n",
    });
    build(root);
    expect(out("robots.txt").toString()).toBe("# kept\nUser-agent: *\n");
    expect(out(".assetsignore").toString()).toBe("*.d.ts\n");
    expect(out("img/x.png").equals(png)).toBe(true);
    expect(out("js/types.d.ts").toString()).toBe("export type T = 1;\n");
  });

  it("writes an unlinked source map beside each module, holding the source", () => {
    project({ "js/a.js": JS, "js/lazy.js": "", "js/lazy-helper.js": "" });
    build(root);
    expect(out("js/a.js").toString()).not.toContain("sourceMappingURL");
    const map = JSON.parse(out("js/a.js.map").toString());
    // Named by its file, so the browser's tools resolve it beside the map, at /js/a.js.
    expect(map.sources).toEqual(["a.js"]);
    expect(map.sourcesContent).toEqual([JS]);
  });

  it("clears a path that changed between file and folder, either way", () => {
    project({ "js/x": "a file", "js/y/inner.txt": "in a folder" });
    build(root);
    rmSync(join(root, "public/js/x"));
    rmSync(join(root, "public/js/y"), { recursive: true });
    writeFileSync(join(root, "public/js/y"), "now a file");
    mkdirSync(join(root, "public/js/x"));
    writeFileSync(join(root, "public/js/x/inner.txt"), "now in a folder");
    expect(build(root).deleted).toEqual(["js/x", "js/y/inner.txt"]);
    expect(out("js/y").toString()).toBe("now a file");
    expect(out("js/x/inner.txt").toString()).toBe("now in a folder");
  });

  it("leaves another build's file in flight alone and leaves no temp file of its own", () => {
    project({ "a.txt": "a" });
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/a.txt.99999.tmp"), "half");
    expect(build(root).deleted).toEqual([]);
    expect(readdirSync(join(root, "dist")).sort()).toEqual(["a.txt", "a.txt.99999.tmp"]);
  });

  it("rewrites only what changed, and deletes what public/ no longer has", () => {
    project({ "js/a.js": "export const a = 1;\n", "b.txt": "b" });
    expect(build(root).written.sort()).toEqual(["b.txt", "js/a.js", "js/a.js.map"]);
    const mtime = statSync(join(root, "dist/js/a.js")).mtimeMs;
    expect(build(root)).toEqual({ written: [], deleted: [] });
    expect(statSync(join(root, "dist/js/a.js")).mtimeMs).toBe(mtime);

    rmSync(join(root, "public/js/a.js"));
    writeFileSync(join(root, "public/b.txt"), "b2");
    expect(build(root)).toEqual({ written: ["b.txt"], deleted: ["js/a.js", "js/a.js.map"] });
    expect(readdirSync(join(root, "dist/js"))).toEqual([]);
    expect(out("b.txt").toString()).toBe("b2");
  });

  it("refuses a module that does not parse, so no broken file is served", () => {
    project({ "js/a.js": "export const = ;\n" });
    expect(() => build(root)).toThrow();
  });

  it("the CLI builds even when reached through a symlinked path", { timeout: SPAWN_TIMEOUT }, () => {
    project({ "js/a.js": "export const a = 1; // gone\n" });
    const link = join(root, "tools-link");
    symlinkSync(join(REPO, "tools"), link);
    const run = spawnSync(process.execPath, [join(link, "build-assets-cli.mjs"), root], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("dist: 2 written");
    expect(out("js/a.js").toString()).not.toContain("gone");
  });
});

describe("immutable names", () => {
  const bytes: Record<string, string> = {
    "fonts/inter.woff2": "font",
    "js/vendor/lib/a.js": "a",
    "js/vendor/lib/b.js": "b",
    "js/workers/sheet.js": "plain",
    "js/workers/pdf/pdf.worker.mjs": "w",
    "js/site.js": "s",
  };
  const read = (rel: string) => bytes[rel] ?? "";

  it("units are each file in fonts/ and js/vendor/, and each folder in js/vendor/ and js/workers/", () => {
    expect([...immutableUnits(Object.keys(bytes)).keys()]).toEqual([
      "fonts/inter.woff2",
      "js/vendor/lib",
      "js/workers/pdf",
    ]);
  });

  it("names the hash a unit's bytes call for, over every file in it and its paths", () => {
    const lib = ["js/vendor/lib/a.js", "js/vendor/lib/b.js"];
    const hash = unitHash("js/vendor/lib", lib, read);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(unitHash("js/vendor/lib", lib, (rel) => (rel.endsWith("b.js") ? "changed" : "a"))).not.toBe(hash);
    expect(unitHash("js/vendor/lib", ["js/vendor/lib/a.js", "js/vendor/lib/c.js"], read)).not.toBe(hash);
  });

  it("flags a unit with no hash, or the wrong one, and passes a unit named for its bytes", () => {
    const rels = ["fonts/inter.woff2", "js/vendor/lib/a.js", "js/vendor/lib/b.js"];
    const lib = unitHash("js/vendor/lib", rels.slice(1), read);
    const font = unitHash("fonts/inter.woff2", ["fonts/inter.woff2"], read);
    expect(staleUnits(rels, read)).toEqual([
      { unit: "fonts/inter.woff2", expected: null },
      { unit: "js/vendor/lib", expected: null },
    ]);
    const named: Record<string, string> = {
      [`fonts/inter-${font}.woff2`]: "font",
      [`js/vendor/lib-${lib}/a.js`]: "a",
      [`js/vendor/lib-${lib}/b.js`]: "b",
    };
    expect(staleUnits(Object.keys(named), (rel) => named[rel] ?? "")).toEqual([]);
    const edited = { ...named, [`fonts/inter-${font}.woff2`]: "changed" };
    expect(staleUnits(Object.keys(edited), (rel) => edited[rel] ?? "")).toEqual([
      {
        unit: `fonts/inter-${font}.woff2`,
        expected: `fonts/inter-${unitHash(`fonts/inter-${font}.woff2`, [`fonts/inter-${font}.woff2`], () => "changed")}.woff2`,
      },
    ]);
  });

  it("the build refuses an unhashed font and says how to fix it", () => {
    const root = mkdtempSync(join(tmpdir(), "bloop-vendor-"));
    mkdirSync(join(root, "public/fonts"), { recursive: true });
    writeFileSync(join(root, "public/fonts/x.woff2"), "x");
    expect(() => build(root)).toThrow(/rehash-immutable.*fonts\/x\.woff2 has no hash/);
    rmSync(root, { recursive: true, force: true });
  });

  it("every immutable unit in public/ carries the hash of its bytes", () => {
    const rels = readdirSync(join(REPO, "public"), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(join(REPO, "public").length + 1));
    expect(immutableUnits(rels).size).toBeGreaterThan(2);
    expect(staleUnits(rels, (rel) => readFileSync(join(REPO, "public", rel)))).toEqual([]);
  });
});

describe("module preload", () => {
  const sources: Record<string, string> = {
    "js/page.js":
      'import { a } from "./core/a.js";\nexport { z } from "./core/z.js";\nconst lazy = () => import("./core/lazy.js");\n',
    "js/core/a.js": 'import "./b.js";\nimport { c } from "../shared/c.js";\n',
    "js/core/b.js": "export const b = 1;\n",
    "js/core/z.js": 'import { a } from "./a.js";\n',
    "js/core/lazy.js": "export const l = 1;\n",
    "js/shared/c.js": "export const c = 1;\n",
  };
  const read = (rel: string) => sources[rel] ?? "";

  it("walks static imports and re-exports once each, and never an import()", () => {
    expect(importClosure("js/page.js", read)).toEqual([
      "js/core/a.js",
      "js/core/b.js",
      "js/core/z.js",
      "js/page.js",
      "js/shared/c.js",
    ]);
  });

  it("puts a modulepreload for each imported module ahead of the page's script, with its indent", () => {
    const html =
      '<head>\n    <link rel="stylesheet" href="/css/a.css">\n    <script type="module" src="/js/page.js"></script>\n</head>';
    const out = withModulePreload(html, read);
    expect(out).toBe(
      [
        "<head>",
        '    <link rel="stylesheet" href="/css/a.css">',
        '    <link rel="modulepreload" href="/js/core/a.js">',
        '    <link rel="modulepreload" href="/js/core/b.js">',
        '    <link rel="modulepreload" href="/js/core/z.js">',
        '    <link rel="modulepreload" href="/js/shared/c.js">',
        '    <script type="module" src="/js/page.js"></script>',
        "</head>",
      ].join("\n"),
    );
  });

  it("leaves a page with no module script, or a script with no imports, as it is", () => {
    expect(withModulePreload("<p>hi</p>", read)).toBe("<p>hi</p>");
    const bare = '<script type="module" src="/js/core/b.js"></script>';
    expect(withModulePreload(bare, read)).toBe(bare);
  });
});

describe("every browser module", () => {
  const modules = readdirSync(join(REPO, "public/js"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"))
    .sort();

  it("the shape read covers static imports, import() and exports", async () => {
    const phone = await shape(readFileSync(join(REPO, "public/js/phone.js"), "utf8"));
    expect(phone.imports).toContain("dynamic-import ./core/remote-ui.js");
    expect(phone.imports).toContain("import-statement ./core/api.js");
    expect((await shape(readFileSync(join(REPO, "public/js/core/ui.js"), "utf8"))).exports.length).toBeGreaterThan(3);
  });

  it.each(modules)("%s keeps its exports and imports, and gains no eval", async (rel) => {
    const source = readFileSync(join(REPO, "public/js", rel), "utf8");
    const { code } = minify(source, `js/${rel}`);
    expect(await shape(code)).toEqual(await shape(source));
    // Trusted Types and the CSP (no 'unsafe-eval') refuse string-to-code; the minifier must never introduce it.
    const count = (text: string, sink: string) => text.split(sink).length - 1;
    for (const sink of ["eval(", "Function(", 'setTimeout("', "setTimeout('", "setTimeout(`"]) {
      expect(count(code, sink), sink).toBeLessThanOrEqual(count(source, sink));
    }
  });
});

/**
 * Every selector list and at-rule prelude, in order, with comments, quotes and optional whitespace gone. A
 * descendant space (`:is(.a) h1`) is kept: only an at-rule prelude, where no space is a combinator, loses all of it.
 */
function preludes(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<=^|[{};])([^{};]+)\{/g)].map((m) => {
    const text = (m[1] ?? "").trim().replace(/["']/g, "");
    if (text.startsWith("@")) return text.replace(/\s+/g, "");
    return text
      .replace(/\s+/g, " ")
      .replace(/\s*([>+~,])\s*/g, "$1")
      .replace(/([(:])\s+|\s+(\))/g, "$1$2");
  });
}

describe("every stylesheet", () => {
  const sheets = readdirSync(join(REPO, "public/css")).filter((f) => f.endsWith(".css"));

  it("the prelude read sees each rule, and :popover-open rules exist to guard", () => {
    const css = '/* x */ .a > .b , .c { color: red } @media (width < 9px) { :is([m="x"]) .d { top: 0 } }';
    expect(preludes(css)).toEqual([".a>.b,.c", "@media(width<9px)", ":is([m=x]) .d"]);
    expect(preludes(":is(.a)h1{top:0}")).not.toEqual(preludes(":is(.a) h1{top:0}"));
    expect(sheets.length).toBeGreaterThan(5);
    const all = sheets.flatMap((f) => preludes(readFileSync(join(REPO, "public/css", f), "utf8")));
    expect(all.filter((p) => p === ".side:not(:popover-open)").length).toBeGreaterThan(0);
  });

  // Same list in the same order: no rule merged, split, dropped or reordered, so a lone :popover-open rule stays alone.
  it.each(sheets)("%s keeps every selector list and at-rule, in order", (rel) => {
    const source = readFileSync(join(REPO, "public/css", rel), "utf8");
    const built = minifyCss(source, `css/${rel}`);
    expect(built).not.toContain("/*");
    expect(built.length).toBeLessThan(source.length);
    expect(preludes(built)).toEqual(preludes(source));
  });
});
