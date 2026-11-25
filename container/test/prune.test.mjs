// Tests container/prune-images.mjs against a throwaway git repo and a fake wrangler. Run: node --test container/test/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../prune-images.mjs", import.meta.url));

const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require("node:fs");
const state = process.env.STATE;
let tags = JSON.parse(fs.readFileSync(state, "utf8"));
const [, , verb, arg] = process.argv.slice(2);
if (verb === "list") console.log(JSON.stringify([{ name: "bloop-converter", tags }]));
if (verb === "delete") fs.writeFileSync(state, JSON.stringify(tags.filter((t) => t !== arg.split(":")[1])));
`;

/** A repo whose main has four commits, plus a branch commit that is not on main. */
function fixture({ pinMessage = (tag) => `Converter image ${tag}: bump digest to sha256:abc` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (file, message, when) => {
    mkdirSync(join(dir, "container"), { recursive: true });
    writeFileSync(join(dir, file), `${message}\n`);
    git("add", file);
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    return `sha-${git("rev-parse", "--short=12", "HEAD")}`;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const c1 = commit("a.txt", "one", "2026-01-01T00:00:00Z");
  const c2 = commit("container/digest.txt", pinMessage(c1), "2026-01-02T00:00:00Z");
  const c3 = commit("a.txt", "three", "2026-01-03T00:00:00Z");
  const c4 = commit("a.txt", "four", "2026-01-04T00:00:00Z");
  git("update-ref", "refs/remotes/origin/main", "main");
  git("checkout", "-q", "-b", "side", c1.slice(4));
  const side = commit("b.txt", "side", "2026-01-05T00:00:00Z");
  git("checkout", "-q", "main");
  const wrangler = join(dir, "wrangler");
  writeFileSync(wrangler, FAKE_WRANGLER);
  chmodSync(wrangler, 0o755);
  const state = join(dir, "state.json");
  const prune = (tags, current) => {
    writeFileSync(state, JSON.stringify(tags));
    const r = spawnSync("node", [SCRIPT, wrangler, current], {
      cwd: dir,
      env: { ...process.env, STATE: state },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout + r.stderr, left: JSON.parse(readFileSync(state, "utf8")) };
  };
  // The publish job leaves its checkout on the bump branch, which already names the new image.
  const checkoutBumpBranch = () => {
    git("checkout", "-q", "-b", "bump");
    commit("container/digest.txt", `Converter image ${c4}: bump digest`, "2026-01-06T00:00:00Z");
  };
  return { c1, c2, c3, c4, side, prune, checkoutBumpBranch };
}

test("the pinned image is read from origin/main, not from the bump branch checked out in the job", () => {
  const f = fixture();
  f.checkoutBumpBranch();
  const r = f.prune([f.c1, f.c3, f.c4], f.c4);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...r.left].sort(), [f.c1, f.c3, f.c4].sort());
});

test("keeps the pinned image, the one just pushed and the newest other main image; deletes the rest", () => {
  const f = fixture();
  // c1 is the pinned image (named by the bump commit), c4 was just pushed, c3 is the newest other on main.
  const r = f.prune([f.c1, f.c2, f.c3, f.c4, f.side, "sha-000000000000"], f.c4);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...r.left].sort(), [f.c1, f.c3, f.c4].sort());
});

test("a branch push never displaces the pinned image or main's newest", () => {
  const f = fixture();
  const r = f.prune([f.c1, f.c3, f.c4, f.side], f.side);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...r.left].sort(), [f.c1, f.c4, f.side].sort());
});

test("refuses to prune when the pinned image cannot be named", () => {
  const f = fixture({ pinMessage: () => "Converter image: bump digest" });
  const r = f.prune([f.c1, f.c2, f.c3, f.c4], f.c4);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.left, [f.c1, f.c2, f.c3, f.c4]);
});

test("fails when more than 4 images remain, and leaves foreign tags alone", () => {
  const f = fixture();
  const r = f.prune([f.c1, f.c4, "latest", "keep-a", "keep-b"], f.c4);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.left, [f.c1, f.c4, "latest", "keep-a", "keep-b"]);
});
