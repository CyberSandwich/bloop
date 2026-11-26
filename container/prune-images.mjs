// Deletes old bloop-converter images from the Cloudflare registry; container/README.md (CI and publishing) owns the rules.
// Usage, from the repository root: node container/prune-images.mjs <wrangler script run by node> <tag just pushed>
import { execFileSync } from "node:child_process";

const [wrangler, current] = process.argv.slice(2);
const REPO = "bloop-converter";
const DIGEST_FILE = "container/digest.txt";
const MAX = 4;
const TAG = /sha-[0-9a-f]{12}-\d+-\d+/;
const ours = (tag) => new RegExp(`^${TAG.source}$`).test(tag);

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
/** The token reaches wrangler only through tools/pinned-wrangler.mjs in CI, so it is a script, never a binary on PATH. */
const wranglerRun = (args) => run(process.execPath, [wrangler, ...args]);

/** Exact repository name: `--filter` matches substrings, and another repository's tags are not ours to count. */
const images = () =>
  JSON.parse(wranglerRun(["containers", "images", "list", "--json", "--filter", REPO]))
    .filter((r) => r.name === REPO)
    .flatMap((r) => r.tags);

/**
 * What origin/main pinned, newest first, as {digest, tag}. The registry lists tags, not digests, so each
 * commit that wrote digest.txt names its tag in its message and the file at that commit holds the digest.
 * Read from origin/main, never the working tree: the checkout is the commit that was built, not necessarily the pin.
 */
function pins() {
  const commits = run("git", ["log", "--format=%H", "origin/main", "--", DIGEST_FILE]).split("\n").filter(Boolean);
  return commits.flatMap((c) => {
    let digest;
    try {
      digest = run("git", ["show", `${c}:${DIGEST_FILE}`]).trim();
    } catch {
      return []; // the file was deleted in this commit
    }
    const message = run("git", ["log", "-1", "--format=%B", c]);
    const tag = message.match(TAG)?.[0];
    if (!tag) throw new Error(`commit ${c} wrote ${DIGEST_FILE} but its message names no tag; refusing to prune`);
    const said = message.match(/sha256:[0-9a-f]{64}/)?.[0];
    if (said && said !== digest) throw new Error(`commit ${c} says ${said} but pins ${digest}; refusing to prune`);
    return [{ digest, tag }];
  });
}

const [live, previous] = pins();
const before = images();
console.log(
  `images before: ${before.join(", ") || "none"}; live: ${live?.tag ?? "none"}; previous: ${previous?.tag ?? "none"}`,
);
if (live && !before.includes(live.tag)) {
  console.error(`the live image ${live.tag} (${live.digest}) is not in the registry; deleting nothing`);
  process.exit(1);
}

const keep = new Set([current, live?.tag, previous?.tag]);
for (const tag of before.filter((t) => ours(t) && !keep.has(t))) {
  console.log(`deleting ${REPO}:${tag}`);
  wranglerRun(["containers", "images", "delete", `${REPO}:${tag}`, "--skip-confirmation"]);
}

const after = images();
console.log(`images after: ${after.join(", ")}`);
if (after.length > MAX) {
  console.error(`${after.length} images remain, more than ${MAX}`);
  process.exit(1);
}
