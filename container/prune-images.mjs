// Prunes the sha-tagged bloop-converter images in the Cloudflare registry, then fails if more than MAX
// remain (the account cap is 50 GB). Kept: the image main pins in container/digest.txt, the image just
// pushed, and the newest other image built from a commit on main. Run from the repository root.
// Usage: node container/prune-images.mjs <wrangler> <current tag>
import { execFileSync } from "node:child_process";

const [wrangler, current] = process.argv.slice(2);
const REPO = "bloop-converter";
const DIGEST_FILE = "container/digest.txt";
const MAX = 4;
const shaTag = /^sha-[0-9a-f]{12}$/;

const run = (cmd, args, stderr = "inherit") =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", stderr] });

const images = () =>
  JSON.parse(run(wrangler, ["containers", "images", "list", "--json", "--filter", REPO])).flatMap((r) =>
    r.tags.map((tag) => ({ ref: `${r.name}:${tag}`, tag })),
  );

/** Commit time of the sha a tag names; 0 when the commit is unknown here. */
function commitTime(tag) {
  try {
    return Number(run("git", ["log", "-1", "--format=%ct", tag.slice(4)], "ignore").trim()) || 0;
  } catch {
    return 0;
  }
}

function onMain(tag) {
  try {
    run("git", ["merge-base", "--is-ancestor", tag.slice(4), "origin/main"], "ignore");
    return true;
  } catch {
    return false;
  }
}

/**
 * The tag of the image main pins. The registry lists no digests, so the commit on origin/main that
 * last wrote digest.txt names the tag it pinned (a squash or merge commit keeps the PR title with it).
 * The working tree is not consulted: the bump branch built in the same job already holds the new digest.
 */
function pinnedTag() {
  try {
    run("git", ["cat-file", "-e", `origin/main:${DIGEST_FILE}`], "ignore");
  } catch {
    return null;
  }
  const message = run("git", ["log", "-1", "--format=%B", "origin/main", "--", DIGEST_FILE]);
  const tag = message.match(/sha-[0-9a-f]{12}/)?.[0];
  if (!tag) throw new Error(`${DIGEST_FILE} exists but no commit message names the tag it pins; refusing to prune`);
  return tag;
}

const pinned = pinnedTag();
const before = images();
console.log(`images before: ${before.map((i) => i.tag).join(", ") || "none"}; pinned: ${pinned ?? "none"}`);

const newestOther = before
  .filter((i) => shaTag.test(i.tag) && i.tag !== current && i.tag !== pinned && onMain(i.tag))
  .sort((a, b) => commitTime(b.tag) - commitTime(a.tag))
  .slice(0, 1);
const keep = new Set([current, pinned, ...newestOther.map((i) => i.tag)]);

for (const image of before.filter((i) => shaTag.test(i.tag) && !keep.has(i.tag))) {
  console.log(`deleting ${image.ref}`);
  run(wrangler, ["containers", "images", "delete", image.ref, "--skip-confirmation"]);
}

const after = images();
console.log(`images after: ${after.map((i) => i.tag).join(", ")}`);
if (after.length > MAX) {
  console.error(`${after.length} images remain, more than ${MAX}`);
  process.exit(1);
}
