// Fast-forwards main to a commit that CI has already run green, refusing what a land must never carry. Usage:
//   node tools/land.mjs <sha> [--dry-run]
// It never forces: a push that is not a fast-forward is refused here and again by the remote.
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attributed } from "./attribution.mjs";
import { ATTRIBUTED, blocks, depsAround, parseDiff } from "./change-tier.mjs";
import { wranglerConfig } from "./wrangler-config.mjs";

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

/** JSON with object keys sorted, so a reformatted step that says the same reads the same. */
const canonical = (/** @type {unknown} */ value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v,
  );

/**
 * Why `head`'s Durable Object migration steps break the shipped ones, one line each: a shipped step is never edited,
 * removed or moved, and each new step's tag is the next `v<n>` after the last shipped one (wrangler applies tags in
 * order, once each).
 * @param {{ tag: string }[]} shipped @param {{ tag: string }[]} head @returns {string[]}
 */
export function migrationProblems(shipped, head) {
  const changed = shipped
    .filter((step, i) => canonical(head[i]) !== canonical(step))
    .map((step) => `Durable Object migration ${step.tag} was edited or removed: a shipped step never changes`);
  if (changed.length > 0) return changed;
  const last = shipped.at(-1)?.tag ?? "v0";
  const n = /^v(\d+)$/.exec(last);
  if (!n) return [`cannot number after the shipped Durable Object migration tag ${last}`];
  return head.slice(shipped.length).flatMap((step, k) => {
    const want = `v${Number(n[1]) + k + 1}`;
    return step.tag === want ? [] : [`new Durable Object migration tag ${step.tag} must be ${want}: renumber it`];
  });
}

/** An added line that opens, splits or closes a merge conflict (diff3's base marker included). */
const MARKER = /^\+(?:<{7}|\|{7}|={7}|>{7})(?: |$)/;

/**
 * Each commit and file whose patch adds a conflict marker: a resolution that failed and was committed anyway. Read
 * per commit, so a marker one commit adds and a later one removes is still caught.
 * @param {string} log `git log --format=%x01%h -p -U0 --no-color` output @returns {string[]}
 */
export function markerProblems(log) {
  const out = new Set();
  // A commit starts where \x01 opens a line; patch content lines open with +, - or a space, so \x01 inside one is text.
  for (const chunk of `\n${log}`.split("\n\x01").slice(1)) {
    const [hash = "", ...lines] = chunk.split("\n");
    let file = "";
    // Between `diff --git` and the first hunk a `+++` line names the file; inside a hunk it is content.
    let header = false;
    for (const line of lines) {
      if (line.startsWith("diff --git ")) header = true;
      else if (line.startsWith("@@")) header = false;
      else if (header && line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
      else if (!header && MARKER.test(line)) out.add(`${hash} adds a conflict marker to ${file}`);
    }
  }
  return [...out];
}

/**
 * The commit-msg hook's blocks (`change-tier.mjs`), run on each commit in `range`: cherry-pick and rebase commit
 * without running the hook, so a commit made that way is checked here or nowhere. Lookups use the full hash (a ref
 * named like a short one would win); the short one is for display.
 * @param {(args: string[]) => string} git @param {string} range @returns {string[]}
 */
export function commitMsgProblems(git, range) {
  const show = (/** @type {string} */ spec) => git(["show", spec]);
  const diff = (/** @type {string} */ hash, /** @type {string} */ mode) =>
    git(["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "-z", mode, hash]);
  return git(["log", "--reverse", "--format=%H %h", range])
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [hash = "", short = ""] = line.split(" ");
      // The stored message, read raw: the hook's comment stripping must not hide a `#` line that verbatim cleanup kept.
      const message = git(["log", "-1", "--format=%B", hash]);
      const out = new Set(
        blocks(
          parseDiff(diff(hash, "--numstat"), diff(hash, "--name-status")),
          depsAround(show, `${hash}^:`, `${hash}:`),
          message,
        ),
      );
      if (attributed(message)) out.add(ATTRIBUTED);
      return [...out].map((problem) => `${short}: ${problem}`);
    });
}

/**
 * Why `sha` must not land on `branch` of `remote`; none means it may. Looks for conflict copies before anything else
 * touches git, then fetches, so the checks run against the remote's tip, never a stale local copy.
 * @param {{ cwd: string, sha: string, remote?: string, branch?: string }} at
 * @returns {string[]}
 */
export function refusals({ cwd, sha, remote = "origin", branch = "main" }) {
  const git = (/** @type {string[]} */ args) =>
    // A range's patch can run to many megabytes; the default 1 MiB buffer would throw.
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
    }).trim();
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
  problems.push(...commitMsgProblems(git, `${tip}..${sha}`));
  problems.push(
    ...markerProblems(git(["log", "--format=%x01%h", "-p", "-U0", "--no-color", "--no-ext-diff", `${tip}..${sha}`])),
  );
  const steps = (/** @type {string} */ rev) => {
    try {
      git(["cat-file", "-e", `${rev}:wrangler.jsonc`]);
    } catch {
      return null;
    }
    return wranglerConfig(git(["show", `${rev}:wrangler.jsonc`])).migrations ?? [];
  };
  try {
    const [shipped, head] = [steps(tip), steps(sha)];
    // A removed or renamed config would carry its migrations past the check, so it is refused, never skipped.
    if (shipped && !head) problems.push(`wrangler.jsonc is gone at ${sha}: its migrations cannot be checked`);
    else if (head) problems.push(...migrationProblems(shipped ?? [], head));
  } catch (e) {
    problems.push(`cannot read wrangler.jsonc migrations: ${/** @type {Error} */ (e).message}`);
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
