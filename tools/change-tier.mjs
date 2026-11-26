// Classifies the staged change into a tier and, with --msg-file, enforces three hard blocks.
// Run: node tools/change-tier.mjs --staged [--msg-file PATH]. The tiers and gates are defined in CLAUDE.md "change loop".
// The decisions are pure functions over data so test/unit/change-tier.test.ts needs no git.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attributed } from "./attribution.mjs";

/** @typedef {{path: string, status: "A" | "M" | "D" | "T", added: number, deleted: number}} ChangedFile */
/** @typedef {Record<string, string>} Deps */
/** @typedef {{tier: 0 | 1 | 2, reasons: string[], gates: string[]}} Tier */

const T0_MAX_LINES = 40;
const T2_MIN_LINES = 400;
const NO_DOCS_TRAILER = /^Docs: none needed$/m;
const DEP_SECTIONS = ["dependencies", "devDependencies"];

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

/** A spec that names its own source (`npm:other@1`, `git+https:`, `file:`, `user/repo`) can swap the package under a kept name. */
const OTHER_SOURCE = /[:/]/;

/**
 * Whether the change brings in or drops a package, the case that needs an ADR line: a name added, removed or moved
 * between sections, or a spec that points at another source. A registry version bump of a kept name is not one.
 * @param {Deps | undefined} before
 * @param {Deps | undefined} after
 */
export function depsAddedOrRemoved(before, after) {
  const [b, a] = [before ?? {}, after ?? {}];
  const names = (/** @type {Deps} */ d) => JSON.stringify(Object.keys(d).sort());
  if (names(b) !== names(a)) return true;
  return Object.keys(a).some((k) => a[k] !== b[k] && (OTHER_SOURCE.test(a[k] ?? "") || OTHER_SOURCE.test(b[k] ?? "")));
}

/**
 * @param {ChangedFile[]} files
 * @param {{before?: Deps | undefined, after?: Deps | undefined}} [deps] both dependency sections of package.json (see `dependencySections`) before and after.
 * @returns {Tier}
 */
export function classify(files, deps = {}) {
  /** @type {string[]} */
  const t2 = [];
  const lines = files.reduce((sum, f) => sum + f.added + f.deleted, 0);

  if (depsChanged(deps.before, deps.after)) t2.push("dependencies or devDependencies changed");
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
 * The three hard blocks, applied to a commit message.
 * @param {ChangedFile[]} files
 * @param {{before?: Deps | undefined, after?: Deps | undefined}} deps
 * @param {string} message
 * @returns {string[]} one line per violated rule; empty when the commit may proceed
 */
export function blocks(files, deps, message) {
  /** @type {string[]} */
  const out = [];
  if (depsAddedOrRemoved(deps.before, deps.after) && !files.some((f) => f.path.startsWith("docs/adr/"))) {
    out.push(
      "a package was added to or removed from `dependencies` or `devDependencies` but no docs/adr/ file is staged: add the ADR line (why, what it replaces, how to remove it).",
    );
  }
  const touchesSrc = files.some((f) => f.path.startsWith("src/"));
  const touchesDocsOrTest = files.some((f) => f.path.startsWith("docs/") || f.path.startsWith("test/"));
  if (touchesSrc && !touchesDocsOrTest && !NO_DOCS_TRAILER.test(stripComments(message))) {
    out.push(
      "src/ changed but no docs/ or test/ file is staged: stage them, or end the message with the line `Docs: none needed`.",
    );
  }
  if (attributed(stripComments(message))) {
    out.push(
      "the message carries AI attribution (Co-Authored-By, Claude-Session or the like): remove it; commits carry none.",
    );
  }
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
 * Both dependency sections of a package.json, flattened to `section:name` so a move between them counts.
 * @param {string} text
 * @returns {Deps}
 */
export function dependencySections(text) {
  const pkg = JSON.parse(text);
  /** @type {Deps} */
  const out = {};
  for (const section of DEP_SECTIONS) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) out[`${section}:${name}`] = String(version);
  }
  return out;
}

/** @returns {{before: Deps | undefined, after: Deps | undefined}} */
function stagedDeps() {
  /** @param {string} spec */
  const read = (spec) => {
    try {
      return dependencySections(git(["show", spec]));
    } catch {
      return undefined;
    }
  };
  return { before: read("HEAD:package.json"), after: read(":package.json") };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--staged")) {
    console.error("usage: node tools/change-tier.mjs --staged [--msg-file PATH]");
    process.exit(2);
  }
  const msgIndex = args.indexOf("--msg-file");
  const files = stagedFiles();
  const deps = stagedDeps();

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
