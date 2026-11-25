import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attributed, conflictCopies, refusals } from "../../tools/land.mjs";

/** A bare remote with one commit on main, and a clone of it to land from. */
let root: string;
let clone: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const commit = (message: string, file = "a.txt") => {
  writeFileSync(join(clone, file), `${message}\n`);
  git(clone, "add", file);
  git(clone, "commit", "-q", "-m", message);
  return git(clone, "rev-parse", "HEAD");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "land-"));
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(root, "clone", "-q", join(root, "remote.git"), "work");
  clone = join(root, "work");
  git(clone, "checkout", "-q", "-b", "main");
  commit("first");
  git(clone, "push", "-q", "origin", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("land: what a fast-forward to main refuses", () => {
  it("land: a clean fast-forward has no refusals", () => {
    const sha = commit("second");
    expect(refusals({ cwd: clone, sha })).toEqual([]);
  });

  it("land: an iCloud conflict copy in .git stops it before any fetch, naming the path", () => {
    const sha = commit("second");
    writeFileSync(join(clone, ".git", "refs", "heads", "main 2"), `${sha}\n`);
    const [problem, ...rest] = refusals({ cwd: clone, sha });
    expect(rest).toEqual([]);
    expect(problem).toMatch(/^iCloud conflict copies in \.git/);
    expect(problem).toContain(join("refs", "heads", "main 2"));
  });

  it("land: a commit that is not a fast-forward of the remote's main is refused", () => {
    const behind = git(clone, "rev-parse", "HEAD");
    commit("second");
    git(clone, "push", "-q", "origin", "main");
    git(clone, "checkout", "-q", "-b", "side", behind);
    const sha = commit("diverged", "b.txt");
    expect(refusals({ cwd: clone, sha })).toEqual([
      `${sha} is not a fast-forward of origin/main: rebase it onto origin/main first`,
    ]);
  });

  it("land: a merge commit in the range is refused", () => {
    const base = git(clone, "rev-parse", "HEAD");
    git(clone, "checkout", "-q", "-b", "side");
    commit("side work", "b.txt");
    git(clone, "checkout", "-q", "main");
    commit("main work");
    git(clone, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const sha = git(clone, "rev-parse", "HEAD");
    expect(git(clone, "merge-base", "--is-ancestor", base, sha)).toBe("");
    const problems = refusals({ cwd: clone, sha });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^merge commits in origin\/main\.\./);
  });

  it("land: an attribution trailer in any commit of the range is refused, naming that commit", () => {
    commit("clean");
    const sha = commit("work\n\nCo-Authored-By: Someone <noreply@anthropic.com>");
    expect(refusals({ cwd: clone, sha })).toEqual([`${sha.slice(0, 7)} carries AI attribution in its message`]);
  });

  it("land: a sha that does not exist is refused", () => {
    expect(refusals({ cwd: clone, sha: "f".repeat(40) })).toEqual([`${"f".repeat(40)} is not a commit here`]);
  });
});

describe("land: the attribution and conflict-copy rules", () => {
  it("land: the trailers and footers count, a commit that only mentions CLAUDE.md does not", () => {
    expect(attributed("x\n\nCo-Authored-By: A <a@b>")).toBe(true);
    expect(attributed("x\n\nClaude-Session: https://example.test/s")).toBe(true);
    expect(attributed("x\n\nGenerated with [Claude Code](https://example.test)")).toBe(true);
    expect(attributed("Update CLAUDE.md pointer to tools/land.mjs")).toBe(false);
  });

  it("land: conflict copies are names ending in a space and a number, with or without an extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "copies-"));
    for (const f of ["index", "index 2", "packed-refs 3", "config", "FETCH_HEAD"]) writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "note 2.md"), "");
    expect(conflictCopies(dir).map((p) => p.slice(dir.length + 1))).toEqual(["index 2", "note 2.md", "packed-refs 3"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
