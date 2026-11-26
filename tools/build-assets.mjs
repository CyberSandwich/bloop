// Builds dist/, the directory wrangler serves: public/ copied byte for byte, except each JS module minified on its
// own (no bundle), so the module graph, lazy import() specifiers and export names stay as written, and each
// stylesheet stripped of comments and whitespace, and each page of its comments. ADR 0011.
// The CLI is tools/build-assets-cli.mjs; wrangler.jsonc `build` runs it before `wrangler dev` and `wrangler deploy`.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const REPO = fileURLToPath(new URL("../", import.meta.url));
// The browser floor (design.md): syntax past it is lowered, and syntax that cannot be lowered fails the build.
export const TARGET = "safari15.4";
// A build's file in flight (`<path>.<pid>.tmp`): another build's is never deleted from under it.
const IN_FLIGHT = /\.\d+\.tmp$/;

/** @param {string} dir @returns {string[]} files under dir, relative and `/`-separated; none when dir is missing */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join("/"))
    .sort();
}

/**
 * The minified module and its source map. The map is never linked (no sourceMappingURL), so no user downloads
 * even its name; a developer attaches `/js/<file>.map` in the browser's tools by hand, and its source shows
 * beside the module, at `/js/<file>`.
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
    sourcefile: basename(rel),
    // A license comment (the vendored QR file's) stays where it is.
    legalComments: "inline",
  });
}

/**
 * A stylesheet with its comments and whitespace removed and nothing else. No minifySyntax: it merges rules with the
 * same body into one selector list, and a lone `:popover-open` rule must stay apart, since an engine that does not
 * know the selector drops the whole list (design.md). No target, so no syntax is lowered or rewritten.
 * @param {string} source
 * @param {string} rel path under public/
 */
export function minifyCss(source, rel) {
  return transformSync(source, { loader: "css", minifyWhitespace: true, sourcefile: basename(rel) }).code;
}

// A start or end tag's name; a raw-text element's content is data, never markup.
const TAG = /<(\/?)([a-z][^\s/>]*)/iy;
const RAW_TEXT = /^(script|style|textarea|title)$/i;

/** Where the tag whose attributes start at `from` ends (after its `>`, quotes respected), or -1. */
function tagEnd(/** @type {string} */ html, /** @type {number} */ from) {
  let quote = "";
  for (let k = from; k < html.length; k++) {
    const c = html[k];
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return k + 1;
  }
  return -1;
}

/**
 * The page without its comments. `<script>`, `<style>`, `<textarea>` and `<title>` content is copied as written
 * (JSON-LD may hold `<!--`); a line a comment leaves empty goes with it. Anything this does not read the way a
 * browser does throws, so the strip never guesses: an unterminated, empty (`<!-->`), `--!>`-closed or nested
 * comment, a comment inside `<pre>`, or `<!--` inside a tag (an attribute value). ADR 0011.
 * @param {string} html
 * @param {string} rel path under public/, for the error
 */
export function stripComments(html, rel) {
  let out = "";
  let pre = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    out += html.slice(i, lt);
    i = lt;
    if (html.startsWith("<!--", lt)) {
      if (html.startsWith("<!-->", lt) || html.startsWith("<!--->", lt)) throw new Error(`${rel}: empty comment`);
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) throw new Error(`${rel}: unterminated comment`);
      const body = html.slice(lt + 4, end);
      if (body.includes("<!--")) throw new Error(`${rel}: nested comment`);
      if (body.includes("--!>")) throw new Error(`${rel}: comment closed by --!>`);
      if (pre > 0) throw new Error(`${rel}: comment inside <pre>`);
      i = end + 3;
      // The comment's own line: dropped whole when nothing else is on it.
      const lineStart = out.lastIndexOf("\n") + 1;
      const lineEnd = html.indexOf("\n", i);
      const after = html.slice(i, lineEnd < 0 ? html.length : lineEnd);
      if (out.slice(lineStart).trim() === "" && after.trim() === "") {
        out = out.slice(0, lineStart);
        i = lineEnd < 0 ? html.length : lineEnd + 1;
      }
      continue;
    }
    TAG.lastIndex = lt;
    const tag = TAG.exec(html);
    if (!tag) {
      out += "<";
      i = lt + 1;
      continue;
    }
    const [, slash, name = ""] = tag;
    const tagStop = tagEnd(html, lt + tag[0].length);
    if (tagStop < 0) throw new Error(`${rel}: unterminated <${name}> tag`);
    if (html.slice(lt, tagStop).includes("<!--")) throw new Error(`${rel}: comment inside a <${name}> tag`);
    let stop = tagStop;
    if (!slash && RAW_TEXT.test(name)) {
      const hit = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(tagStop));
      if (!hit) throw new Error(`${rel}: unterminated <${name}>`);
      stop = tagStop + hit.index + hit[0].length;
    } else if (name.toLowerCase() === "pre") pre = Math.max(0, pre + (slash ? -1 : 1));
    out += html.slice(lt, stop);
    i = stop;
  }
  return out + html.slice(i);
}

/**
 * The modules a module script downloads before any import(): itself and everything its static imports reach, as
 * paths under public/. Static imports only, as written in the source (relative specifiers in double quotes).
 * @param {string} entry a path under public/, such as "js/screen.js"
 * @param {(rel: string) => string} read the source of a path under public/
 */
export function importClosure(entry, read) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = /** @type {string} */ (stack.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(/^\s*(?:(?:import|export)\s[^;'"]*?from\s*|import\s+)"(\.[^"]+)"/gm)) {
      stack.push(posix.join(posix.dirname(file), m[1] ?? ""));
    }
  }
  return [...seen].sort();
}

const MODULE_SCRIPT = /^([ \t]*)<script type="module" src="\/(js\/[^"]+)"><\/script>/m;

/**
 * The page with a `<link rel="modulepreload">` for each module its script imports, ahead of the script, so the browser
 * fetches the whole graph at once instead of one import level per round trip. The script itself is already found.
 * @param {string} html
 * @param {(rel: string) => string} read the source of a path under public/
 */
export function withModulePreload(html, read) {
  const found = MODULE_SCRIPT.exec(html);
  if (!found) return html;
  const [tag, indent = "", entry = ""] = found;
  const links = importClosure(entry, read)
    .filter((rel) => rel !== entry)
    .map((rel) => `${indent}<link rel="modulepreload" href="/${rel}">\n`);
  return html.replace(tag, () => `${links.join("")}${tag}`);
}

/** @param {string} path @param {Buffer | string} data */
function same(path, data) {
  try {
    return readFileSync(path).equals(Buffer.from(data));
  } catch {
    return false;
  }
}

/** @param {string} path @returns {"file" | "dir" | undefined} */
function kind(path) {
  try {
    return lstatSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

/**
 * The file origin (ADR 0018) as a module, so a page that needs it stays a plain asset with a stable ETag. It is
 * FILE_ORIGIN from the environment (a staging build), else the `vars` entry of wrangler.jsonc.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 */
export function fileOriginModule(root, env = process.env) {
  const live = readFileSync(join(root, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const origin = env.FILE_ORIGIN ?? JSON.parse(live).vars?.FILE_ORIGIN ?? "";
  return `export const FILE_ORIGIN = ${JSON.stringify(origin)};\n`;
}

/**
 * The files under fonts/ and js/vendor/ whose path carries no version (`4.1`, `0.1.3`). Those two folders are served
 * `immutable` (ADR 0023), so a file changes only by getting a new name.
 * @param {string[]} rels paths under public/
 */
export function unversioned(rels) {
  return rels.filter((rel) => /^(fonts|js\/vendor)\//.test(rel) && !/\d+\.\d+/.test(rel));
}

/**
 * Brings `<root>/dist` to the build of `<root>/public`. Stale files go first, then any path of the wrong kind (a
 * file that became a folder, or the reverse). A changed file is written to a per-process temp name and renamed
 * over its target, so a server reading dist/ never sees half a file and two builds never share a temp file; an
 * unchanged file is left alone.
 * @param {string} root
 * @returns {{ written: string[], deleted: string[] }}
 */
export function build(root = REPO) {
  const src = join(root, "public");
  const out = join(root, "dist");
  /** @type {Map<string, Buffer | string>} */
  const files = new Map();
  const sources = walk(src);
  const bare = unversioned(sources);
  if (bare.length > 0) throw new Error(`immutable folders need a version in the name: ${bare.join(", ")}`);
  for (const rel of sources) {
    const bytes = readFileSync(join(src, rel));
    if (rel.endsWith(".css")) {
      files.set(rel, minifyCss(bytes.toString("utf8"), rel));
      continue;
    }
    if (rel.endsWith(".html")) {
      const html = stripComments(bytes.toString("utf8"), rel);
      files.set(
        rel,
        withModulePreload(html, (path) => readFileSync(join(src, path), "utf8")),
      );
      continue;
    }
    if (!rel.endsWith(".js")) {
      files.set(rel, bytes);
      continue;
    }
    const { code, map } = minify(bytes.toString("utf8"), rel);
    files.set(rel, code);
    files.set(`${rel}.map`, map);
  }

  // Only a real project has a wrangler.jsonc: a build of a bare folder bakes nothing.
  if (kind(join(root, "wrangler.jsonc")) === "file") files.set("js/shared/fo.js", fileOriginModule(root));

  const deleted = walk(out).filter((rel) => !files.has(rel) && !IN_FLIGHT.test(rel));
  for (const rel of deleted) rmSync(join(out, rel), { force: true });

  /** @type {string[]} */
  const written = [];
  for (const [rel, data] of files) {
    const path = join(out, rel);
    if (same(path, data)) continue;
    // A file that became a folder was stale above; a folder that became a file is emptied, so clear it here.
    if (kind(path) === "dir") rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
    written.push(rel);
  }
  return { written, deleted };
}
