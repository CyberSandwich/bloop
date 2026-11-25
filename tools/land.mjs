// Fast-forwards main to a commit that CI has already run green, refusing what a land must never carry. Usage:
//   node tools/land.mjs <sha> [--dry-run]
// It never forces: a push that is not a fast-forward is refused here and again by the remote.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Trailers and footers that attribute a commit to an AI tool (CLAUDE.md: commits carry none). */
const ATTRIBUTION = [
  /^\s*co-authored-by:/im,
  /^\s*claude-session:/im,
  /^\s*generated-by:/im,
  /noreply@anthropic\.com/i,
  /generated with \[?claude/i,
];

/** @param {string} message @returns {boolean} */
export const attributed = (message) => ATTRIBUTION.some((re) => re.test(message));

/**
 * iCloud's conflict copies (`<name> 2`, `index 3`) under a git dir: a ref copy breaks fetch and holds a stale value.
 * @param {string} gitDir @returns {string[]} their paths
 */
export function conflictCopies(gitDir) {
  /** @type {string[]} */
  const found = [];
  for (const d of readdirSync(gitDir, { recursive: true, withFileTypes: true })) {
    if (/ \d+(\.[^/]*)?$/.test(d.name)) found.push(join(d.parentPath, d.name));
  }
  return found.sort();
}

/**
 * Why `sha` must not land on `branch` of `remote`; none means it may. Fetches first, so the check is against the
 * remote's tip, never a stale local copy.
 * @param {{ cwd: string, sha: string, remote?: string, branch?: string }} at
 * @returns {string[]}
 */
export function refusals({ cwd, sha, remote = "origin", branch = "main" }) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const copies = conflictCopies(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (copies.length > 0) return [`iCloud conflict copies in .git, move them out first: ${copies.join(", ")}`];
  git(["fetch", "--quiet", remote]);
  const tip = `${remote}/${branch}`;
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    return [`${sha} is not a commit here`];
  }
  try {
    git(["merge-base", "--is-ancestor", tip, sha]);
  } catch {
    return [`${sha} is not a fast-forward of ${tip}: rebase it onto ${tip} first`];
  }
  const problems = [];
  const merges = git(["log", "--merges", "--format=%h", `${tip}..${sha}`]);
  if (merges) problems.push(`merge commits in ${tip}..${sha} (main takes none): ${merges.split("\n").join(", ")}`);
  for (const line of git(["log", "--format=%h%x00%B%x01", `${tip}..${sha}`]).split("\x01")) {
    const [hash = "", body = ""] = line.trim().split("\0");
    if (hash && attributed(body)) problems.push(`${hash} carries AI attribution in its message`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sha, flag] = process.argv.slice(2);
  if (!sha || (flag && flag !== "--dry-run")) {
    console.error("usage: node tools/land.mjs <sha> [--dry-run]");
    process.exit(64);
  }
  const cwd = process.cwd();
  const problems = refusals({ cwd, sha });
  for (const p of problems) console.error(`land: ${p}`);
  if (problems.length > 0) process.exit(1);
  const range = execFileSync("git", ["log", "--oneline", `origin/main..${sha}`], { cwd, encoding: "utf8" });
  console.log(`land: ${range.trim().split("\n").length} commit(s) onto origin/main\n${range.trim()}`);
  if (flag === "--dry-run") process.exit(0);
  execFileSync("git", ["push", "origin", `${sha}:refs/heads/main`], { cwd, stdio: "inherit" });
}
