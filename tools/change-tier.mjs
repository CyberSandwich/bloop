// Classifies the staged change into a tier and, with --msg-file, enforces two hard blocks.
// Run: node tools/change-tier.mjs --staged [--msg-file PATH]. The tiers and gates are defined in CLAUDE.md "change loop".
// The decisions are pure functions over data so test/unit/change-tier.test.ts needs no git.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @typedef {{path: string, status: "A" | "M" | "D" | "T", added: number, deleted: number}} ChangedFile */
/** @typedef {Record<string, string>} Deps */
/** @typedef {{tier: 0 | 1 | 2, reasons: string[], gates: string[]}} Tier */

const T0_MAX_LINES = 40;
const T2_MIN_LINES = 400;
const NO_DOCS_TRAILER = /^Docs: none needed$/m;

const GATES = {
  0: ["npm run check"],
  1: ["npm run check", "light LLM before/after (CLAUDE.md change loop: five answers, then /code-review low)"],
  2: ["plan mode", "an ADR or ADR line", "/code-review high", "/security-review", "npm run check"],
};

/** @param {string} path */
const isDocsOrTest = (path) => path.startsWith("docs/") || path.startsWith("test/") || path.endsWith(".md");

/** Paths whose change is T2 whatever its size: header policy and authentication. */
/** @type {{pattern: RegExp, label: string}[]} */
const SENSITIVE = [
  { pattern: /^src\/worker\/(.*\/)?headers\.ts$/, label: "header policy" },
  { pattern: /^public\/_headers$/, label: "static header policy" },
  { pattern: /^src\/worker\/auth\//, label: "auth code" },
  { pattern: /^src\/worker\/routes\/auth\.ts$/, label: "auth route" },
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

/**
 * @param {ChangedFile[]} files
 * @param {{before?: Deps, after?: Deps}} [deps] `dependencies` of package.json before and after the change.
 * @returns {Tier}
 */
export function classify(files, deps = {}) {
  /** @type {string[]} */
  const t2 = [];
  const lines = files.reduce((sum, f) => sum + f.added + f.deleted, 0);

  if (depsChanged(deps.before, deps.after)) t2.push("dependencies changed");
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
 * The two hard blocks, applied to a commit message.
 * @param {ChangedFile[]} files
 * @param {{before?: Deps, after?: Deps}} deps
 * @param {string} message
 * @returns {string[]} one line per violated rule; empty when the commit may proceed
 */
export function blocks(files, deps, message) {
  /** @type {string[]} */
  const out = [];
  if (depsChanged(deps.before, deps.after) && !files.some((f) => f.path.startsWith("docs/adr/"))) {
    out.push(
      "`dependencies` changed but no docs/adr/ file is staged: add the ADR line (why, what it replaces, how to remove it).",
    );
  }
  const touchesSrc = files.some((f) => f.path.startsWith("src/"));
  const touchesDocsOrTest = files.some((f) => f.path.startsWith("docs/") || f.path.startsWith("test/"));
  if (touchesSrc && !touchesDocsOrTest && !NO_DOCS_TRAILER.test(stripComments(message))) {
    out.push(
      "src/ changed but no docs/ or test/ file is staged: stage them, or end the message with the line `Docs: none needed`.",
    );
  }
  return out;
}

/** @param {string} message git's commit-msg file holds `#` comment lines that are not part of the message. */
const stripComments = (message) =>
  message
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");

/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** @returns {ChangedFile[]} the staged diff, renames split into a delete and an add so each path has one status. */
function stagedFiles() {
  const numstat = git(["diff", "--cached", "--no-renames", "--numstat"]).split("\n").filter(Boolean);
  const counts = new Map(
    numstat.map((line) => {
      const [added = "0", deleted = "0", ...path] = line.split("\t");
      // Binary files show "-": they count as no lines.
      return [path.join("\t"), { added: Number(added) || 0, deleted: Number(deleted) || 0 }];
    }),
  );
  return git(["diff", "--cached", "--no-renames", "--name-status"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "M", ...path] = line.split("\t");
      const file = path.join("\t");
      const count = counts.get(file) ?? { added: 0, deleted: 0 };
      return /** @type {ChangedFile} */ ({ path: file, status: status.charAt(0), ...count });
    });
}

/** @returns {{before?: Deps, after?: Deps}} */
function stagedDeps() {
  /** @param {string} spec */
  const read = (spec) => {
    try {
      return JSON.parse(git(["show", spec])).dependencies;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
