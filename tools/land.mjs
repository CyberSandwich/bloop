// Fast-forwards main to a commit that CI has already run green, refusing what a land must never carry. Usage:
//   node tools/land.mjs <sha> [--dry-run]
// It never forces: a push that is not a fast-forward is refused here and again by the remote.
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
 * iCloud's conflict copies (`<name> 2`, `index 3`, `note 2.md`) under a git dir: a ref copy breaks fetch and holds a
 * stale value. A folder under `worktrees/` or `modules/` is named by the user, so its own name never counts; what
 * iCloud copies inside it does.
 * @param {string} gitDir @returns {string[]} their paths
 */
export function conflictCopies(gitDir) {
  /** @type {string[]} */
  const found = [];
  for (const d of readdirSync(gitDir, { recursive: true, withFileTypes: true })) {
    const parent = d.parentPath;
    const userNamed =
      d.isDirectory() && dirname(parent) === gitDir && ["worktrees", "modules"].includes(basename(parent));
    if (!userNamed && / \d+(\.[^/]*)?$/.test(d.name)) found.push(join(d.parentPath, d.name));
  }
  return found.sort();
}

/**
 * Why `sha` must not land on `branch` of `remote`; none means it may. Looks for conflict copies before anything else
 * touches git, then fetches, so the checks run against the remote's tip, never a stale local copy.
 * @param {{ cwd: string, sha: string, remote?: string, branch?: string }} at
 * @returns {string[]}
 */
export function refusals({ cwd, sha, remote = "origin", branch = "main" }) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const copies = conflictCopies(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (copies.length > 0) return [`iCloud conflict copies in .git, move them out first: ${copies.join(", ")}`];
  if (sha.startsWith("-")) return [`${sha} is not a commit here`];
  try {
    git(["fetch", "--quiet", remote]);
  } catch (e) {
    return [`fetch from ${remote} failed: ${String(/** @type {any} */ (e).stderr ?? e).trim()}`];
  }
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

/**
 * The CLI: checks, then pushes the checked commit by its full id, so the pushed value is the one the checks read.
 * @param {string[]} args @param {string} cwd @returns {number} the exit code
 */
export function main(args, cwd) {
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("-")) {
    console.error("usage: node tools/land.mjs <sha> [--dry-run]");
    return 64;
  }
  const problems = refusals({ cwd, sha: rest[0] });
  for (const p of problems) console.error(`land: ${p}`);
  if (problems.length > 0) return 1;
  const git = (/** @type {string[]} */ a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const id = git(["rev-parse", "--verify", `${rest[0]}^{commit}`]);
  const range = git(["log", "--oneline", `origin/main..${id}`]);
  if (!range) {
    console.log("land: nothing to land, origin/main is already there");
    return 0;
  }
  console.log(`land: ${range.split("\n").length} commit(s) onto origin/main\n${range}`);
  if (dryRun) return 0;
  execFileSync("git", ["push", "origin", `${id}:refs/heads/main`], { cwd, stdio: "inherit" });
  return 0;
}

// Real paths on both sides: run through a symlink (macOS /tmp is one) a plain compare is false and nothing runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  process.exit(main(process.argv.slice(2), process.cwd()));
