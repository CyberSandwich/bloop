// Fails when a change raises a size-limit budget: a limit only ever holds or drops (design.md, budgets). Holds every
// entry on HEAD to the base (baseRefFor). There is no override: a raise needs this script changed, in plain view.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// size-limit's own parser (size-limit/bytes.js, not exported), copied exactly so both read a limit the same way.
const PARSE_REGEXP = /^([+-]?\d+(?:\.\d+)?) *(?:([kmgtpezy])?(i)?b)?$/i;

/** @param {string | number} value e.g. "0.72 kB" @returns {number} bytes; an unreadable limit throws */
export function parseLimit(value) {
  if (typeof value === "number") return value;
  const match = PARSE_REGEXP.exec(String(value));
  if (!match) throw new Error(`size-ratchet: cannot read limit ${JSON.stringify(value)}`);
  const [, number = "", prefix, iec] = match;
  const power = prefix ? "kmgtpezy".indexOf(prefix.toLowerCase()) + 1 : 0;
  return Math.floor(Number.parseFloat(number) * (iec ? 1024 : 1000) ** power);
}

/**
 * @typedef {{ name: string, path: string | string[], limit: string | number, gzip?: boolean, brotli?: boolean,
 *   import?: unknown, ignore?: unknown }} Entry
 * @typedef {{ show: (file: string) => string | null, list: (dir: string) => string[] }} Tree
 * @typedef {{ onBase: (path: string) => boolean, onHead: (path: string) => boolean }} Sources
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
/** What an entry measures besides its compression: a different value moves bytes between entries. */
const measure = (/** @type {Entry} */ e) => JSON.stringify([paths(e), e.import ?? null, e.ignore ?? null]);
/** size-limit's precedence (@size-limit/file): gzip first, then brotli off, else brotli. */
const compression = (/** @type {Entry} */ e) => (e.gzip === true ? "gzip" : e.brotli === false ? "none" : "brotli");
/**
 * The files an entry measures, as sources: dist/ is built from public/ (ADR 0011). A glob cannot be checked file by
 * file, and a path with no public/ source cannot be checked at all, so neither ever counts as absent (fails closed).
 */
const sources = (/** @type {Entry} */ e) => paths(e).map((p) => p.replace(/^dist\//, "public/"));
const checkable = (/** @type {string} */ p) => !/[*?[{]/.test(p) && p.startsWith("public/");
const kb = (/** @type {number} */ bytes) => `${bytes / 1000} kB`;

/**
 * Why HEAD's budgets break the ratchet, one line each; none means it passes.
 * - An entry matched by name, or else by path, fails when its limit rises or its compression changes.
 * - Moved bytes: when a base entry gives bytes up (its measure changed, or it was removed), those entries and every
 *   added entry form one group whose limits on HEAD may not sum past the base's, since an added entry may be what the
 *   bytes moved to (a split, a rename). A split or a newly lazy module moves bytes and passes; a rename plus a raise,
 *   or a narrowed path plus a new entry for the rest, fails.
 * - With nothing given up, an added entry is a budget that did not exist and passes, even for a file the base had.
 * - A removed entry also fails while any of its files stays.
 * @param {Entry[]} base @param {Entry[]} head @param {Sources} has
 */
export function compare(base, head, has) {
  const problems = [];
  /** @type {Entry[]} */ const movedFrom = [];
  /** @type {Entry[]} */ const movedTo = [];
  /** @type {Set<Entry>} */ const matched = new Set();
  for (const before of base) {
    const after =
      head.find((e) => e.name === before.name) ?? head.find((e) => !matched.has(e) && measure(e) === measure(before));
    if (!after) {
      const kept = sources(before).filter((p) => !checkable(p) || has.onHead(p) || !has.onBase(p));
      if (kept.length > 0) problems.push(`"${before.name}" was removed but HEAD still has ${kept.join(", ")}`);
      movedFrom.push(before);
      continue;
    }
    matched.add(after);
    if (parseLimit(after.limit) > parseLimit(before.limit)) {
      problems.push(`"${after.name}" limit raised from ${before.limit} to ${after.limit}`);
    }
    if (compression(after) !== compression(before)) {
      problems.push(`"${after.name}" compression changed from ${compression(before)} to ${compression(after)}`);
    }
    if (measure(after) !== measure(before)) {
      movedFrom.push(before);
      movedTo.push(after);
    }
  }
  if (movedFrom.length > 0) movedTo.push(...head.filter((e) => !matched.has(e)));
  const sum = (/** @type {Entry[]} */ es) => es.reduce((n, e) => n + parseLimit(e.limit), 0);
  if (movedTo.length > 0 && sum(movedTo) > sum(movedFrom)) {
    const names = (/** @type {Entry[]} */ es) => es.map((e) => `"${e.name}"`).join(", ") || "none";
    problems.push(
      `measure changed, review: ${names(movedTo)} sum to ${kb(sum(movedTo))}, over the ${kb(sum(movedFrom))} of ${names(movedFrom)} they replace`,
    );
  }
  return problems;
}

/**
 * The commit HEAD's budgets are held to: off main, the merge-base with origin/main; on main, the push's previous tip
 * (BEFORE) when it is a real commit here, so a fast-forward of many commits is checked whole, else HEAD~1 (a schedule
 * run, a branch's first push, or a force push whose old tip is gone).
 * @param {{ branch: string, before: string, isCommit: (sha: string) => boolean, mergeBase: () => string }} at
 */
export function baseRefFor({ branch, before, isCommit, mergeBase }) {
  if (branch !== "main") return mergeBase();
  if (/^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before) && isCommit(before)) return before;
  return "HEAD~1";
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

// Real paths on both sides: run through a symlink (macOS /tmp is one) a plain compare is false and nothing runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const base = baseRefFor({
    branch: process.env.GITHUB_REF_NAME ?? git(["rev-parse", "--abbrev-ref", "HEAD"]),
    before: process.env.BEFORE ?? "",
    isCommit: (sha) => ok(["cat-file", "-e", `${sha}^{commit}`]),
    mergeBase: () => git(["merge-base", "HEAD", "origin/main"]),
  });
  const problems = compare(entriesFrom(treeAt(base)), entriesFrom(treeAt("HEAD")), {
    onBase: (p) => ok(["cat-file", "-e", `${base}:${p}`]),
    onHead: (p) => ok(["cat-file", "-e", `HEAD:${p}`]),
  });
  for (const p of problems) console.log(`::error title=size ratchet::${p} (base ${base.slice(0, 12)})`);
  if (problems.length > 0) process.exit(1);
  console.log(`size ratchet: no limit raised against ${base.slice(0, 12)}`);
}
