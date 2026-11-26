// Builds dist/, the directory wrangler serves: public/ copied byte for byte, except each JS module minified on its
// own (no bundle), so the module graph, lazy import() specifiers and export names stay as written, and each
// stylesheet stripped of comments and whitespace, and each page of its comments. ADR 0011.
// The CLI is tools/build-assets-cli.mjs; wrangler.jsonc `build` runs it before a local `wrangler dev` and `wrangler deploy`
// (the CI deploy jobs use the check job's dist/ instead: tools/prebuilt.mjs).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 * The files of `<root>/public` that git does not ignore: a `.DS_Store` inside an immutable unit must not change its hash,
 * and the build and `tools/rehash-immutable.mjs` must list the same files. Outside a git work tree, every file.
 * @param {string} root
 */
function publicFiles(root) {
  const all = walk(join(root, "public"));
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "public"], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.status !== 0) return all;
  const keep = new Set(
    listed.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => file.slice("public/".length)),
  );
  return all.filter((rel) => keep.has(rel));
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
 * The immutable units of public/ (ADR 0023): each file in fonts/ and js/vendor/, and each folder in js/vendor/ and
 * js/workers/ (a script directly in js/workers/ is not one). A unit is served `immutable`, so it changes only by
 * getting a new name: the name ends in `-<8 hex>`, the start of the SHA-256 of its built bytes, before any extension.
 * The hash is of what is served, so a minifier upgrade renames the unit too, and a name stands for one content.
 * @param {string[]} rels paths under dist/
 * @returns {Map<string, string[]>} unit path to the files it holds
 */
export function immutableUnits(rels) {
  /** @type {Map<string, string[]>} */
  const units = new Map();
  for (const rel of rels) {
    const unit = /^(fonts\/[^/]+|js\/vendor\/[^/]+|js\/workers\/[^/]+(?=\/))/.exec(rel)?.[1];
    if (unit) units.set(unit, [...(units.get(unit) ?? []), rel]);
  }
  return units;
}

const UNIT_NAME = /^(.+)-([0-9a-f]{8})(\.[^/]*)?$/;

/**
 * The 8 hex a unit's name must carry: its files' paths inside it and bytes, in path order.
 * @param {string} unit
 * @param {string[]} files
 * @param {(rel: string) => Buffer | string} read
 */
export function unitHash(unit, files, read) {
  const hash = createHash("sha256");
  for (const rel of [...files].sort())
    hash
      .update(`${rel.slice(unit.length)}\0`)
      .update(read(rel))
      .update("\0");
  return hash.digest("hex").slice(0, 8);
}

/**
 * The units whose name does not carry their bytes' hash, with the name each should have (null when the name has no hash
 * to replace; add `-00000000` before the extension and rehash).
 * @param {string[]} rels
 * @param {(rel: string) => Buffer | string} read
 * @returns {{ unit: string, expected: string | null }[]}
 */
export function staleUnits(rels, read) {
  /** @type {{ unit: string, expected: string | null }[]} */
  const stale = [];
  for (const [unit, files] of immutableUnits(rels)) {
    const name = unit.slice(unit.lastIndexOf("/") + 1);
    const hash = unitHash(unit, files, read);
    const parts = UNIT_NAME.exec(name);
    if (!parts) stale.push({ unit, expected: null });
    else if (parts[2] !== hash) {
      stale.push({ unit, expected: `${unit.slice(0, unit.length - name.length)}${parts[1]}-${hash}${parts[3] ?? ""}` });
    }
  }
  return stale;
}

/**
 * The built bytes of every file of `<root>/public`, by path under dist/.
 * @param {string} root
 */
export function builtFiles(root = REPO) {
  const src = join(root, "public");
  /** @type {Map<string, Buffer | string>} */
  const files = new Map();
  for (const rel of publicFiles(root)) {
    const bytes = readFileSync(join(src, rel));
    if (rel.endsWith(".css")) {
      files.set(rel, minifyCss(bytes.toString("utf8"), rel));
    } else if (rel.endsWith(".html")) {
      const html = stripComments(bytes.toString("utf8"), rel);
      files.set(
        rel,
        withModulePreload(html, (path) => readFileSync(join(src, path), "utf8")),
      );
    } else if (rel.endsWith(".js")) {
      const { code, map } = minify(bytes.toString("utf8"), rel);
      files.set(rel, code);
      files.set(`${rel}.map`, map);
    } else {
      files.set(rel, bytes);
    }
  }
  return files;
}

/**
 * The immutable units of a build whose name is not the hash of its served bytes. A source map is left out of the hash:
 * it names its own file, and it is a debugging aid, not what a page runs.
 * @param {Map<string, Buffer | string>} files
 */
export function staleBuilt(files) {
  return staleUnits(
    [...files.keys()].filter((rel) => !rel.endsWith(".map")),
    (rel) => files.get(rel) ?? "",
  );
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
  const out = join(root, "dist");
  const files = builtFiles(root);
  const stale = staleBuilt(files);
  if (stale.length > 0) {
    const list = stale.map((s) => (s.expected ? `${s.unit} should be ${s.expected}` : `${s.unit} has no hash`));
    throw new Error(
      `an immutable name must end in the hash of its bytes (node tools/rehash-immutable.mjs): ${list.join("; ")}`,
    );
  }

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
