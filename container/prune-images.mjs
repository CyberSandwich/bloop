// Keeps the image just pushed plus the two newest images built from commits on main, deletes every
// other sha-tagged bloop-converter image, then fails if more than MAX images remain (the account cap
// is 50 GB). The digest main pins is the newest or the one before it, so it is never deleted.
// Usage: node container/prune-images.mjs <wrangler> <current tag>
import { execFileSync } from "node:child_process";

const [wrangler, current] = process.argv.slice(2);
const REPO = "bloop-converter";
const KEEP_ON_MAIN = 2;
const MAX = 4;

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

const shaTag = /^sha-[0-9a-f]{12}$/;
const before = images();
console.log(`images before: ${before.map((i) => i.tag).join(", ") || "none"}`);

const newestOnMain = before
  .filter((i) => shaTag.test(i.tag) && onMain(i.tag))
  .sort((a, b) => commitTime(b.tag) - commitTime(a.tag))
  .slice(0, KEEP_ON_MAIN);
const keep = new Set([current, ...newestOnMain.map((i) => i.tag)]);

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
