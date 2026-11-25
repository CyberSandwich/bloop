// Tests container/prune-images.mjs against a throwaway git repo and a fake wrangler. Run: node --test container/test/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../prune-images.mjs", import.meta.url));

// The registry state is {repo: [tags]}; delete takes "repo:tag". `--filter` matches substrings, like the real one.
const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require("node:fs");
const state = process.env.STATE;
const repos = JSON.parse(fs.readFileSync(state, "utf8"));
const args = process.argv.slice(2);
if (args[2] === "list") {
  const filter = args[args.indexOf("--filter") + 1];
  console.log(JSON.stringify(Object.entries(repos).filter(([n]) => n.includes(filter)).map(([name, tags]) => ({ name, tags }))));
}
if (args[2] === "delete") {
  const [name, tag] = args[3].split(":");
  repos[name] = repos[name].filter((t) => t !== tag);
  fs.writeFileSync(state, JSON.stringify(repos));
}
`;

const D = (n) => `sha256:${String(n).repeat(64)}`;
let run = 100;
const tagOf = (n) => `sha-${String(n).repeat(12)}-${run++}-1`;

/** A repo whose origin/main grows one bump commit at a time. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const commit = (file, content, message) => {
    mkdirSync(join(dir, "container"), { recursive: true });
    writeFileSync(join(dir, file), content);
    git("add", file);
    git("commit", "-q", "-m", message);
  };
  commit("a.txt", "one\n", "one");
  /** Lands a bump on main: the commit message names the tag, the file holds the digest. */
  const bump = (n, message = (tag) => `Converter image ${tag}: bump digest to ${D(n)}`) => {
    const tag = tagOf(n);
    commit("container/digest.txt", `${D(n)}\n`, message(tag));
    git("update-ref", "refs/remotes/origin/main", "main");
    return tag;
  };
  const wrangler = join(dir, "wrangler");
  writeFileSync(wrangler, FAKE_WRANGLER);
  chmodSync(wrangler, 0o755);
  const state = join(dir, "state.json");
  const prune = (repos, current) => {
    writeFileSync(state, JSON.stringify(Array.isArray(repos) ? { "bloop-converter": repos } : repos));
    const r = spawnSync("node", [SCRIPT, wrangler, current], {
      cwd: dir,
      env: { ...process.env, STATE: state },
      encoding: "utf8",
    });
    const left = JSON.parse(readFileSync(state, "utf8"));
    return { code: r.status, out: r.stdout + r.stderr, left: left["bloop-converter"], all: left };
  };
  return { dir, git, commit, bump, prune };
}

const sorted = (a) => [...a].sort();

test("keeps the live image, the one before it and the one just pushed; deletes the rest", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const t2 = f.bump(2);
  const t3 = f.bump(3);
  const stray = tagOf(8);
  const current = tagOf(9);
  const r = f.prune([t1, t2, t3, stray, current], current);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sorted(r.left), sorted([t2, t3, current]));
});

test("the live image comes from origin/main, not from the bump branch checked out in the job", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const t2 = f.bump(2);
  const current = tagOf(9);
  f.git("checkout", "-q", "-b", "bump");
  f.commit("container/digest.txt", `${D(9)}\n`, `Converter image ${current}: bump digest to ${D(9)}`);
  const r = f.prune([t1, t2, current], current);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sorted(r.left), sorted([t1, t2, current]));
});

test("a squash-merge message with the tag in the title and no digest still names the pin", () => {
  const f = fixture();
  const t1 = f.bump(1, (tag) => `Converter image ${tag}: bump digest (#41)`);
  const r = f.prune([t1, tagOf(7)], tagOf(9));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.left, [t1]);
});

test("deletes nothing and fails when the live image is not in the registry", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const t2 = f.bump(2);
  const others = [t1, tagOf(7), tagOf(8)];
  const r = f.prune(others, tagOf(9));
  assert.notEqual(r.code, 0);
  assert.match(r.out, new RegExp(t2));
  assert.deepEqual(r.left, others);
});

test("refuses to prune when a pinning commit names no tag", () => {
  const f = fixture();
  f.bump(1, () => "Converter image: bump digest");
  const tags = [tagOf(7), tagOf(8)];
  const r = f.prune(tags, tagOf(9));
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.left, tags);
});

test("refuses to prune when the message names a digest the file does not hold", () => {
  const f = fixture();
  f.bump(1, (tag) => `Converter image ${tag}: bump digest to ${D(5)}`);
  const tags = [tagOf(7)];
  const r = f.prune(tags, tagOf(9));
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.left, tags);
});

test("with no digest.txt on main yet, nothing is pinned and only the stale images go", () => {
  const f = fixture();
  f.git("update-ref", "refs/remotes/origin/main", "main");
  const current = tagOf(9);
  const old = tagOf(7);
  const r = f.prune([old, current], current);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.left, [current]);
});

test("with one pin in history there is no previous image to keep", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const current = tagOf(9);
  const r = f.prune([t1, tagOf(7), current], current);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sorted(r.left), sorted([t1, current]));
});

test("only the exact repository is read or pruned", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const current = tagOf(9);
  const lookalike = [t1, tagOf(7), tagOf(8)];
  const r = f.prune({ "bloop-converter": [t1, current], "bloop-converter-old": lookalike }, current);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.all["bloop-converter-old"], lookalike);
});

test("a lookalike repository does not satisfy the live image", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const stray = tagOf(7);
  const r = f.prune({ "bloop-converter": [stray], "bloop-converter-old": [t1] }, tagOf(9));
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.left, [stray]);
});

test("fails when more than 4 images remain, and leaves foreign tags alone", () => {
  const f = fixture();
  const t1 = f.bump(1);
  const current = tagOf(9);
  const tags = [t1, current, "latest", "keep-a", "keep-b"];
  const r = f.prune(tags, current);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.left, tags);
});
