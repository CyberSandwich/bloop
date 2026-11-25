// Fails when a branch raises a size-limit budget: a limit only ever holds or drops (design.md, budgets). Compares
// every entry on HEAD with the same entry on the base: the merge-base with origin/main on a branch; on main, the
// push's previous tip (BEFORE), or HEAD~1 without one. New entries and lowered limits pass; a removed entry passes
// only once its file is gone too.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Bytes per unit, as size-limit reads them; an unknown unit throws, so a typo never reads as "no budget". */
const UNITS = { B: 1, kB: 1000, KB: 1000, MB: 1000 ** 2 };

/** @param {string} limit e.g. "0.72 kB" @returns {number} bytes */
export function parseLimit(limit) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(String(limit));
  const unit = m?.[2] && Object.hasOwn(UNITS, m[2]) ? UNITS[/** @type {keyof typeof UNITS} */ (m[2])] : undefined;
  if (!m || unit == null) throw new Error(`size-ratchet: cannot read limit ${JSON.stringify(limit)}`);
  return Number(m[1]) * unit;
}

/**
 * @typedef {{ name: string, path: string | string[], limit: string, gzip?: boolean, brotli?: boolean }} Entry
 * @typedef {{ show: (file: string) => string | null, list: (dir: string) => string[] }} Tree
 */

/** Config files size-limit reads, as JSON: package.json's key, `.size-limit(.json)`, and `tools/size/*.json`. */
export function entriesFrom(/** @type {Tree} */ tree) {
  /** @type {Entry[]} */
  const entries = [];
  const pkg = tree.show("package.json");
  if (pkg != null) entries.push(...(JSON.parse(pkg)["size-limit"] ?? []));
  for (const file of [
    ".size-limit",
    ".size-limit.json",
    ...tree.list("tools/size").filter((f) => f.endsWith(".json")),
  ]) {
    const text = tree.show(file);
    if (text != null) entries.push(...[].concat(JSON.parse(text)));
  }
  return entries;
}

const paths = (/** @type {Entry} */ e) => [].concat(/** @type {any} */ (e.path)).map(String);
const samePath = (/** @type {Entry} */ a, /** @type {Entry} */ b) => paths(a).join("\n") === paths(b).join("\n");
const compression = (/** @type {Entry} */ e) => (e.brotli === false ? "none" : e.gzip ? "gzip" : "brotli");

/**
 * Why HEAD's budgets break the ratchet, one line each; none means it passes. An entry is the same entry when its name
 * or its path matches, so a rename cannot carry a raise past the check.
 * @param {Entry[]} base @param {Entry[]} head @param {(path: string) => boolean} existsOnHead a source path in HEAD
 */
export function compare(base, head, existsOnHead) {
  const problems = [];
  for (const before of base) {
    const after = head.find((e) => e.name === before.name) ?? head.find((e) => samePath(e, before));
    if (!after) {
      // A glob cannot be checked file by file, so it counts as kept: removing its entry fails closed.
      // dist/ is built from public/ (ADR 0011), so the file a dist path measures is its public/ source.
      const kept = paths(before)
        .map((p) => p.replace(/^dist\//, "public/"))
        .filter((p) => /[*?[{]/.test(p) || existsOnHead(p));
      if (kept.length > 0) problems.push(`"${before.name}" was removed but HEAD still has ${kept.join(", ")}`);
      continue;
    }
    if (parseLimit(after.limit) > parseLimit(before.limit)) {
      problems.push(`"${after.name}" limit raised from ${before.limit} to ${after.limit}`);
    }
    if (compression(after) !== compression(before)) {
      problems.push(`"${after.name}" compression changed from ${compression(before)} to ${compression(after)}`);
    }
  }
  return problems;
}

const git = (/** @type {string[]} */ args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ok = (/** @type {string[]} */ args) => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

/** @param {string} ref @returns {Tree} */
const treeAt = (ref) => ({
  show: (file) => (ok(["cat-file", "-e", `${ref}:${file}`]) ? git(["show", `${ref}:${file}`]) : null),
  list: (dir) =>
    ok(["cat-file", "-e", `${ref}:${dir}`])
      ? git(["ls-tree", "--name-only", `${ref}:${dir}`])
          .split("\n")
          .filter(Boolean)
          .map((f) => `${dir}/${f}`)
      : [],
});

/** The commit HEAD's budgets are held to; see the header. */
function baseRef() {
  const branch = process.env.GITHUB_REF_NAME ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") return git(["merge-base", "HEAD", "origin/main"]);
  const before = process.env.BEFORE ?? "";
  if (/^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before) && ok(["cat-file", "-e", `${before}^{commit}`]))
    return before;
  return "HEAD~1";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = baseRef();
  const problems = compare(entriesFrom(treeAt(base)), entriesFrom(treeAt("HEAD")), (p) =>
    ok(["cat-file", "-e", `HEAD:${p}`]),
  );
  for (const p of problems) console.log(`::error title=size ratchet::${p} (base ${base.slice(0, 12)})`);
  if (problems.length > 0) process.exit(1);
  console.log(`size ratchet: no limit raised against ${base.slice(0, 12)}`);
}
