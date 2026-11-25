// Builds dist/, the directory wrangler serves: public/ copied byte for byte, except each JS module minified on its
// own (no bundle), so the module graph, lazy import() specifiers and export names stay as written. ADR 0011.
// `node tools/build-assets.mjs`; wrangler.jsonc `build` runs it before `wrangler dev` and `wrangler deploy`.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const REPO = fileURLToPath(new URL("../", import.meta.url));
// The browser floor (design.md): syntax past it is lowered, and syntax that cannot be lowered fails the build.
export const TARGET = "safari15.4";

/** @param {string} dir @returns {string[]} paths relative to dir, `/`-separated */
function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join("/"))
    .sort();
}

/**
 * The minified module and its source map. The map is never linked (no sourceMappingURL), so no user downloads
 * even its name; a developer attaches `/js/<file>.map` in the browser's tools by hand.
 * @param {string} source
 * @param {string} rel path under public/
 */
export function minify(source, rel) {
  return transformSync(source, {
    loader: "js",
    format: "esm",
    minify: true,
    target: TARGET,
    sourcemap: "external",
    sourcefile: `public/${rel}`,
    // A license comment (the vendored QR file's) stays where it is.
    legalComments: "inline",
  });
}

/** @param {string} path @param {Buffer | string} data */
function same(path, data) {
  try {
    return readFileSync(path).equals(Buffer.from(data));
  } catch {
    return false;
  }
}

/**
 * Brings `<root>/dist` to the build of `<root>/public`. A changed file is written beside its target and renamed
 * over it, so a server reading dist/ during a build never sees half a file; an unchanged file is left alone.
 * @param {string} root
 * @returns {{ written: string[], deleted: string[] }}
 */
export function build(root = REPO) {
  const src = join(root, "public");
  const out = join(root, "dist");
  /** @type {Map<string, Buffer | string>} */
  const files = new Map();
  for (const rel of walk(src)) {
    const bytes = readFileSync(join(src, rel));
    if (!rel.endsWith(".js")) {
      files.set(rel, bytes);
      continue;
    }
    const { code, map } = minify(bytes.toString("utf8"), rel);
    files.set(rel, code);
    files.set(`${rel}.map`, map);
  }
  /** @type {string[]} */
  const written = [];
  for (const [rel, data] of files) {
    const path = join(out, rel);
    if (same(path, data)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, data);
    renameSync(`${path}.tmp`, path);
    written.push(rel);
  }
  // A file gone from public/ stops being served.
  const deleted = walk(out).filter((rel) => !files.has(rel));
  for (const rel of deleted) rmSync(join(out, rel));
  return { written, deleted };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { written, deleted } = build();
  console.log(`dist: ${written.length} written, ${deleted.length} deleted`);
}
