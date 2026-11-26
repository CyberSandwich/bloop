import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attributed } from "../../tools/attribution.mjs";
import { conflictCopies, main, markerProblems, migrationProblems, refusals } from "../../tools/land.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

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
}, SPAWN_TIMEOUT);
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("land: what a fast-forward to main refuses", { timeout: SPAWN_TIMEOUT }, () => {
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

  it("land: an attribution trailer below the tip is refused, naming that commit", () => {
    const tagged = commit("work\n\nCo-Authored-By: Someone <someone@example.test>");
    const sha = commit("clean on top", "b.txt");
    expect(refusals({ cwd: clone, sha })).toEqual([`${tagged.slice(0, 7)} carries AI attribution in its message`]);
  });

  it("land: a range of one with only a Claude-Session line, or only the noreply address, is refused", () => {
    const session = commit("work\n\nClaude-Session: https://example.test/s");
    expect(refusals({ cwd: clone, sha: session })).toHaveLength(1);
    git(clone, "reset", "-q", "--hard", "origin/main");
    const noreply = commit("work\n\nSigned-off-by: Bot <noreply@anthropic.com>");
    expect(refusals({ cwd: clone, sha: noreply })).toHaveLength(1);
  });

  it("land: a commit that adds conflict markers is refused, even when a later commit removes them", () => {
    const write = (file: string, text: string, message: string) => {
      writeFileSync(join(clone, file), text);
      git(clone, "add", file);
      git(clone, "commit", "-q", "-m", message);
      return git(clone, "rev-parse", "HEAD");
    };
    const marked = write(
      "w.ts",
      "<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> 1d2f4f08 (x)\n",
      "resolve",
    );
    const sha = write("w.ts", "const a = 1;\n", "fix it after");
    expect(refusals({ cwd: clone, sha })).toEqual([`${marked.slice(0, 7)} adds a conflict marker to w.ts`]);
    // A heading underline, a longer rule or a marker-like word inside a line is not a marker.
    git(clone, "reset", "-q", "--hard", "origin/main");
    const fine = write("d.md", "Title\n=====\n\n========\n\nsee <<<<<<< in text\n", "docs");
    expect(refusals({ cwd: clone, sha: fine })).toEqual([]);
  });

  it("land: a sha that does not exist, or one that reads as an option, is refused", () => {
    expect(refusals({ cwd: clone, sha: "f".repeat(40) })).toEqual([`${"f".repeat(40)} is not a commit here`]);
    expect(refusals({ cwd: clone, sha: "--all" })).toEqual(["--all is not a commit here"]);
  });

  it("land: the conflict-copy stop comes before any fetch: it holds with the remote unreachable", () => {
    const sha = commit("second");
    git(clone, "remote", "set-url", "origin", join(root, "gone.git"));
    expect(refusals({ cwd: clone, sha })[0]).toMatch(/^fetch from origin failed/);
    writeFileSync(join(clone, ".git", "packed-refs 2"), "");
    expect(refusals({ cwd: clone, sha })[0]).toMatch(/^iCloud conflict copies in \.git/);
  });

  it("land: from a linked worktree it reads the shared git dir, and a user's worktree name never counts", () => {
    git(clone, "worktree", "add", "-q", "-b", "wt", join(root, "feature 2"));
    const wt = join(root, "feature 2");
    const sha = commit("second");
    // git names the worktree's own folder under .git/worktrees after the user's path (a space becomes "-").
    const admin = git(wt, "rev-parse", "--path-format=absolute", "--git-dir");
    expect(admin).toMatch(/[/\\]worktrees[/\\]feature.2$/);
    expect(refusals({ cwd: wt, sha })).toEqual([]);
    writeFileSync(join(admin, "index 2"), "");
    expect(refusals({ cwd: wt, sha })[0]).toContain(join("worktrees", basename(admin), "index 2"));
  });

  it("land: a Durable Object migration tag that skips or reuses a number, or an edited shipped step, is refused", () => {
    const steps = (...s: object[]) => `{\n  // the classes\n  "migrations": ${JSON.stringify(s)}\n}\n`;
    const v1 = { tag: "v1", new_sqlite_classes: ["Screen"] };
    const writeAndCommit = (text: string) => {
      writeFileSync(join(clone, "wrangler.jsonc"), text);
      git(clone, "add", "wrangler.jsonc");
      git(clone, "commit", "-q", "-m", "migration");
      return git(clone, "rev-parse", "HEAD");
    };
    writeAndCommit(steps(v1));
    git(clone, "push", "-q", "origin", "main");
    const next = writeAndCommit(steps(v1, { tag: "v2", new_sqlite_classes: ["Guard"] }));
    expect(refusals({ cwd: clone, sha: next })).toEqual([]);
    git(clone, "reset", "-q", "--hard", "origin/main");
    const skipped = writeAndCommit(steps(v1, { tag: "v3", new_sqlite_classes: ["Guard"] }));
    expect(refusals({ cwd: clone, sha: skipped })).toEqual([
      "new Durable Object migration tag v3 must be v2: renumber it",
    ]);
    git(clone, "reset", "-q", "--hard", "origin/main");
    const edited = writeAndCommit(steps({ tag: "v1", new_sqlite_classes: ["Screen", "Guard"] }));
    expect(refusals({ cwd: clone, sha: edited })).toEqual([
      "Durable Object migration v1 was edited or removed: a shipped step never changes",
    ]);
    git(clone, "reset", "-q", "--hard", "origin/main");
    git(clone, "rm", "-q", "wrangler.jsonc");
    git(clone, "commit", "-q", "-m", "config renamed away");
    const gone = git(clone, "rev-parse", "HEAD");
    expect(refusals({ cwd: clone, sha: gone })).toEqual([
      `wrangler.jsonc is gone at ${gone}: its migrations cannot be checked`,
    ]);
  });
});

describe("land: the CLI", { timeout: SPAWN_TIMEOUT }, () => {
  const remoteTip = () => git(join(root, "remote.git"), "rev-parse", "main");

  it("land: a dry run prints the range and pushes nothing; a real run pushes the checked commit", () => {
    const before = remoteTip();
    const sha = commit("second");
    expect(main([sha.slice(0, 9), "--dry-run"], clone)).toBe(0);
    expect(remoteTip()).toBe(before);
    expect(main(["--dry-run", sha.slice(0, 9)], clone)).toBe(0);
    expect(main([sha.slice(0, 9)], clone)).toBe(0);
    expect(remoteTip()).toBe(sha);
  });

  it("land: a refusal exits 1 and pushes nothing; bad arguments exit 64; an empty range lands nothing", () => {
    const before = remoteTip();
    const sha = commit("work\n\nCo-Authored-By: A <a@example.test>");
    expect(main([sha], clone)).toBe(1);
    expect(remoteTip()).toBe(before);
    expect(main([], clone)).toBe(64);
    expect(main(["-x"], clone)).toBe(64);
    expect(main([sha, sha], clone)).toBe(64);
    expect(main([before], clone)).toBe(0);
    expect(remoteTip()).toBe(before);
  });
});

describe("land: conflict markers in a patch", () => {
  const patch = (hash: string, file: string, ...added: string[]) =>
    `\x01${hash}\n\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${added.length} @@\n${added
      .map((l) => `+${l}`)
      .join("\n")}\n`;

  it("names each commit and file once, for every marker kind, diff3's base included", () => {
    expect(
      markerProblems(patch("aaa1111", "x.ts", "<<<<<<< HEAD", "a", "||||||| base", "=======", ">>>>>>> b")),
    ).toEqual(["aaa1111 adds a conflict marker to x.ts"]);
    expect(markerProblems(patch("aaa1111", "x.ts", "=======") + patch("bbb2222", "y.md", ">>>>>>> c"))).toEqual([
      "aaa1111 adds a conflict marker to x.ts",
      "bbb2222 adds a conflict marker to y.md",
    ]);
  });

  it("reads `+++` inside a hunk as content, and lets rules, underlines and words with angle runs pass", () => {
    expect(markerProblems(patch("aaa1111", "x.md", "++ b/other", "<<<<<<< HEAD"))).toEqual([
      "aaa1111 adds a conflict marker to x.md",
    ]);
    expect(markerProblems(patch("aaa1111", "x.md", "=====", "========", "a <<<<<<< b", "<<<<<<<<"))).toEqual([]);
    expect(markerProblems("")).toEqual([]);
  });
});

describe("land: the attribution and conflict-copy rules", { timeout: SPAWN_TIMEOUT }, () => {
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
    mkdirSync(join(dir, "worktrees", "release 2"), { recursive: true });
    mkdirSync(join(dir, "refs", "heads", "x 2"), { recursive: true });
    expect(conflictCopies(dir).map((p) => p.slice(dir.length + 1))).toEqual([
      "index 2",
      "note 2.md",
      "packed-refs 3",
      join("refs", "heads", "x 2"),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("land: Durable Object migration steps", () => {
  const v = (n: number, classes = ["C"]) => ({ tag: `v${n}`, new_sqlite_classes: classes });

  it("land: new steps numbered on from the last shipped tag pass, as do none and a first step", () => {
    expect(migrationProblems([v(1), v(2)], [v(1), v(2), v(3), v(4)])).toEqual([]);
    expect(migrationProblems([v(1)], [v(1)])).toEqual([]);
    expect(migrationProblems([], [v(1)])).toEqual([]);
  });

  it("land: a shipped step whose keys were only reordered is the same step", () => {
    const reordered = { new_sqlite_classes: ["C"], tag: "v1" };
    expect(migrationProblems([v(1)], [reordered, v(2)])).toEqual([]);
  });

  it("land: a reused, skipped or out-of-order tag is refused once per wrong step", () => {
    expect(migrationProblems([v(1), v(2)], [v(1), v(2), v(2, ["D"])])).toEqual([
      "new Durable Object migration tag v2 must be v3: renumber it",
    ]);
    expect(migrationProblems([v(1)], [v(1), v(3), v(2)])).toEqual([
      "new Durable Object migration tag v3 must be v2: renumber it",
      "new Durable Object migration tag v2 must be v3: renumber it",
    ]);
  });

  it("land: a shipped step edited, removed or moved is refused, and nothing is numbered after it", () => {
    expect(migrationProblems([v(1), v(2)], [v(1), v(2, ["D"]), v(3)])).toEqual([
      "Durable Object migration v2 was edited or removed: a shipped step never changes",
    ]);
    expect(migrationProblems([v(1), v(2)], [v(1)])).toHaveLength(1);
    expect(migrationProblems([v(1), v(2)], [v(2), v(1)])).toHaveLength(2);
  });

  it("land: a shipped tag that is not v<n> is refused rather than guessed", () => {
    expect(migrationProblems([{ tag: "init" }], [{ tag: "init" }, v(1)])).toEqual([
      "cannot number after the shipped Durable Object migration tag init",
    ]);
  });
});
