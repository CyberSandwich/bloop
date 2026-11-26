// Classifies the staged change into a tier and, with --msg-file, enforces the hard blocks in `blocks`.
// Run: node tools/change-tier.mjs --staged [--msg-file PATH]. The tiers and gates are defined in CLAUDE.md "change loop".
// The decisions are pure functions over data so test/unit/change-tier.test.ts needs no git.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attributed } from "./attribution.mjs";

/** @typedef {{path: string, status: "A" | "M" | "D" | "T", added: number, deleted: number}} ChangedFile */
/** @typedef {Record<string, string>} Deps */
/**
 * package.json's dependency sections and the lockfile's off-registry entries, before and after a change.
 * @typedef {{before?: Deps | undefined, after?: Deps | undefined, lockBefore?: string[], lockAfter?: string[]}} DepsAround
 */
/** @typedef {{tier: 0 | 1 | 2, reasons: string[], gates: string[]}} Tier */

const T0_MAX_LINES = 40;
const T2_MIN_LINES = 400;
const NO_DOCS_TRAILER = /^Docs: none needed$/m;
/** Every package.json field that can pull a package in or swap one, so none of them bypasses the ADR rule. */
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
];
export const ATTRIBUTED =
  "the message carries AI attribution (Co-Authored-By, Claude-Session or the like): remove it; commits carry none.";

const GATES = {
  0: ["npm run check"],
  1: ["npm run check", "light LLM before/after (CLAUDE.md change loop: five answers, then /code-review low)"],
  2: ["plan mode", "an ADR or ADR line", "/code-review high", "/security-review", "npm run check"],
};

/** @param {string} path */
const isDocsOrTest = (path) => path.startsWith("docs/") || path.startsWith("test/") || path.endsWith(".md");

/** Paths whose change is T2 whatever its size: header policy, authentication and Durable Object schema steps (they are not under migrations/). */
/** @type {{pattern: RegExp, label: string}[]} */
const SENSITIVE = [
  { pattern: /^src\/worker\/(.*\/)?headers\.ts$/, label: "header policy" },
  { pattern: /^public\/_headers$/, label: "static header policy" },
  { pattern: /^src\/worker\/auth\//, label: "auth code" },
  { pattern: /^src\/worker\/routes\/auth\.ts$/, label: "auth route" },
  { pattern: /^src\/worker\/(.*\/)?[^/]*schema[^/]*\.ts$/, label: "Durable Object schema step" },
];

/**
 * @param {Deps | undefined} before
 * @param {Deps | undefined} after
 */
export function depsChanged(before, after) {
  return JSON.stringify(sorted(before ?? {})) !== JSON.stringify(sorted(after ?? {}));
}

/** @param {Deps} deps */
const sorted = (deps) => Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));

const VERSION = String.raw`v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const COMPARATOR = `(?:[~^]|[<>]=?|=)?${VERSION}`;
const RANGE = String.raw`${COMPARATOR}(?:\s+-\s+${VERSION}|(?:\s+${COMPARATOR})*)`;
/**
 * A spec npm resolves from the registry by version alone. Anything else (an alias, git, a URL, a path, a tarball, a
 * dist-tag, `workspace:`) can swap the package under a kept name. npm reads a spec ending in a tarball suffix as a
 * file even when it also parses as a version, so that suffix is refused on its own.
 */
const REGISTRY_RANGE = new RegExp(String.raw`^\s*${RANGE}(?:\s*\|\|\s*${RANGE})*\s*$`);
const TARBALL = /\.(?:tgz|tar\.gz|tar)$/i;
/** @param {string | undefined} spec */
export const registryRange = (spec) => spec !== undefined && REGISTRY_RANGE.test(spec) && !TARBALL.test(spec);

/**
 * Whether the change brings in, drops or re-sources a package, the case that needs an ADR line (ADR 0001 owns the
 * list): a name added, removed or moved between sections, or a changed spec that is not a registry range on both
 * sides. A registry version bump of a kept name is not one.
 * @param {Deps | undefined} before
 * @param {Deps | undefined} after
 */
export function depsAddedOrRemoved(before, after) {
  const [b, a] = [before ?? {}, after ?? {}];
  const names = (/** @type {Deps} */ d) => JSON.stringify(Object.keys(d).sort());
  if (names(b) !== names(a)) return true;
  return Object.keys(a).some((k) => a[k] !== b[k] && !(registryRange(a[k]) && registryRange(b[k])));
}

/**
 * Lockfile entries resolved from anywhere but https://registry.npmjs.org, as `path resolved` lines. Reads lockfile
 * v2/v3 `packages` and v1's nested `dependencies`.
 * @param {string} text package-lock.json
 * @returns {string[]}
 */
export function offRegistry(text) {
  const lock = JSON.parse(text);
  /** @type {string[]} */
  const out = [];
  /** @param {string} path @param {unknown} resolved */
  const check = (path, resolved) => {
    if (resolved === undefined) return;
    let url;
    try {
      url = new URL(String(resolved));
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:" || url.host !== "registry.npmjs.org") out.push(`${path} ${String(resolved)}`);
  };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) check(path, entry?.resolved);
  /** @param {Record<string, any>} deps @param {string} at */
  const walk = (deps, at) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      check(`${at}${name}`, entry?.resolved);
      walk(entry?.dependencies, `${at}${name}>`);
    }
  };
  walk(lock.dependencies, "");
  return out.sort();
}

/**
 * Reads `DepsAround` through `show` (`git show <spec>`); a file that is missing or does not parse reads as none, so
 * dropping or breaking package.json counts as removing every package.
 * @param {(spec: string) => string} show
 * @param {string} before a `git show` prefix for the old side, such as `HEAD:` or `<sha>^:`
 * @param {string} after the prefix for the new side, such as `:` (the index) or `<sha>:`
 * @returns {DepsAround}
 */
export function depsAround(show, before, after) {
  /** @template T @param {string} spec @param {(text: string) => T} parse @returns {T | undefined} */
  const read = (spec, parse) => {
    try {
      return parse(show(spec));
    } catch {
      return undefined;
    }
  };
  return {
    before: read(`${before}package.json`, dependencySections),
    after: read(`${after}package.json`, dependencySections),
    lockBefore: read(`${before}package-lock.json`, offRegistry) ?? [],
    lockAfter: read(`${after}package-lock.json`, offRegistry) ?? [],
  };
}

/**
 * @param {ChangedFile[]} files
 * @param {DepsAround} [deps] package.json's dependency sections (see `dependencySections`) before and after.
 * @returns {Tier}
 */
export function classify(files, deps = {}) {
  /** @type {string[]} */
  const t2 = [];
  const lines = files.reduce((sum, f) => sum + f.added + f.deleted, 0);

  if (depsChanged(deps.before, deps.after)) t2.push("package.json dependency sections changed");
  for (const f of files) {
    if (f.status === "A" && f.path.startsWith("src/worker/seams/")) t2.push(`new seam file ${f.path}`);
    if (f.status === "A" && f.path.startsWith("migrations/")) t2.push(`new migration ${f.path}`);
    const sensitive = SENSITIVE.find(({ pattern }) => pattern.test(f.path));
    if (sensitive) t2.push(`${sensitive.label}: ${f.path}`);
  }
  if (lines > T2_MIN_LINES) t2.push(`${lines} changed lines (over ${T2_MIN_LINES})`);
  if (t2.length > 0) return { tier: 2, reasons: t2, gates: GATES[2] };

  if (files.every((f) => isDocsOrTest(f.path)) && lines < T0_MAX_LINES) {
    return { tier: 0, reasons: [`docs or tests only, ${lines} changed lines`], gates: GATES[0] };
  }
  return { tier: 1, reasons: [`${lines} changed lines`], gates: GATES[1] };
}

/**
 * The hard blocks, applied to a commit message.
 * @param {ChangedFile[]} files
 * @param {DepsAround} deps
 * @param {string} message
 * @returns {string[]} one line per violated rule; empty when the commit may proceed
 */
export function blocks(files, deps, message) {
  /** @type {string[]} */
  const out = [];
  // Deleting an ADR file is not the ADR line the rule asks for.
  const adrTouched = files.some((f) => f.path.startsWith("docs/adr/") && f.status !== "D");
  if (depsAddedOrRemoved(deps.before, deps.after) && !adrTouched) {
    out.push(
      "a package was added, removed or re-sourced in package.json but no docs/adr/ file is staged: add or remove its ADR line (why, what it replaces, how to remove it).",
    );
  }
  const lockBefore = new Set(deps.lockBefore ?? []);
  for (const entry of (deps.lockAfter ?? []).filter((e) => !lockBefore.has(e))) {
    out.push(`package-lock.json resolves ${entry}: only https://registry.npmjs.org is allowed.`);
  }
  const touchesSrc = files.some((f) => f.path.startsWith("src/"));
  const touchesDocsOrTest = files.some((f) => f.path.startsWith("docs/") || f.path.startsWith("test/"));
  if (touchesSrc && !touchesDocsOrTest && !NO_DOCS_TRAILER.test(stripComments(message))) {
    out.push(
      "src/ changed but no docs/ or test/ file is staged: stage them, or end the message with the line `Docs: none needed`.",
    );
  }
  if (attributed(stripComments(message))) out.push(ATTRIBUTED);
  return out;
}

/**
 * @param {string} message git's commit-msg file holds `#` comment lines that are not part of the message, and under
 * `commit -v` the staged diff after a scissors line, whose text would read as the message's; CRLF editors add `\r`.
 */
const stripComments = (message) => {
  const lines = message.replaceAll("\r", "").split("\n");
  const scissors = lines.findIndex((line) => /^# -+ >8 -+$/.test(line));
  return (scissors < 0 ? lines : lines.slice(0, scissors)).filter((line) => !line.startsWith("#")).join("\n");
};

/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Joins `git diff -z --numstat` and `-z --name-status` output (both run with `--no-renames`, so a rename is a
 * delete plus an add and every record has exactly one path). `-z` keeps non-ASCII paths unquoted.
 * @param {string} numstat records `added TAB deleted TAB path NUL`
 * @param {string} nameStatus alternating `status NUL path NUL`
 * @returns {ChangedFile[]}
 */
export function parseDiff(numstat, nameStatus) {
  const counts = new Map(
    numstat
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const [added = "0", deleted = "0", ...path] = record.split("\t");
        // Binary files show "-": they count as no lines.
        return [path.join("\t"), { added: Number(added) || 0, deleted: Number(deleted) || 0 }];
      }),
  );
  const tokens = nameStatus.split("\0");
  /** @type {ChangedFile[]} */
  const files = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const path = tokens[i + 1] ?? "";
    files.push({
      path,
      status: /** @type {ChangedFile["status"]} */ ((tokens[i] ?? "M").charAt(0)),
      ...(counts.get(path) ?? { added: 0, deleted: 0 }),
    });
  }
  return files;
}

const stagedFiles = () =>
  parseDiff(
    git(["diff", "--cached", "--no-renames", "-z", "--numstat"]),
    git(["diff", "--cached", "--no-renames", "-z", "--name-status"]),
  );

/**
 * The dependency sections of a package.json, flattened to `section:name` so a move between them counts. A bundle
 * list holds names only (`true` bundles every dependency), and a nested override reads as its JSON, which is never a
 * registry range.
 * @param {string} text
 * @returns {Deps}
 */
export function dependencySections(text) {
  const pkg = JSON.parse(text);
  /** @type {Deps} */
  const out = {};
  for (const section of DEP_SECTIONS) {
    const value = pkg[section] ?? {};
    const entries = Array.isArray(value)
      ? value.map((name) => [String(name), "bundled"])
      : typeof value === "object"
        ? Object.entries(value)
        : [["*", String(value)]];
    for (const [name, spec] of entries)
      out[`${section}:${name}`] = typeof spec === "string" ? spec : JSON.stringify(spec);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--staged")) {
    console.error("usage: node tools/change-tier.mjs --staged [--msg-file PATH]");
    process.exit(2);
  }
  const msgIndex = args.indexOf("--msg-file");
  const files = stagedFiles();
  const deps = depsAround((spec) => git(["show", spec]), "HEAD:", ":");

  if (msgIndex >= 0) {
    const problems = blocks(files, deps, readFileSync(args[msgIndex + 1] ?? "", "utf8"));
    if (problems.length > 0) {
      for (const problem of problems) console.error(`change-tier: ${problem}`);
      process.exit(1);
    }
  }
  const { tier, reasons, gates } = classify(files, deps);
  console.log(`T${tier}: ${reasons.join("; ")}`);
  console.log(`gates: ${gates.join(" | ")}`);
}

// realpath on both sides: a symlinked path to this file must still run the CLI, never silently pass.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
