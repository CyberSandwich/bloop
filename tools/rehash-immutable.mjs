// Gives every immutable unit under public/ the name its bytes call for (ADR 0023, `staleUnits` in build-assets.mjs) and
// rewrites every reference to the old name. Run it after a font is regenerated or a vendored library is replaced; a new
// unit is named with a `-00000000` placeholder first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { staleUnits } from "./build-assets.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * @param {string} text
 * @param {Map<string, string>} renames old name to new name, each one segment
 */
export function rewriteRefs(text, renames) {
  let out = text;
  for (const [from, to] of renames) out = out.replaceAll(from, to);
  return out;
}

/** @param {string} root @returns {string[]} the repo's files on disk, tracked or not ignored */
function repoFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

/** @param {string} root @returns {Map<string, string>} the renames made, by last path segment */
export function rehash(root = ROOT) {
  const files = repoFiles(root);
  const inPublic = files.filter((f) => f.startsWith("public/")).map((f) => f.slice("public/".length));
  const renames = new Map();
  for (const { unit, expected } of staleUnits(inPublic, (rel) => readFileSync(join(root, "public", rel)))) {
    if (!expected) throw new Error(`${unit} has no hash: add -00000000 before its extension, then rerun`);
    renameSync(join(root, "public", unit), join(root, "public", expected));
    renames.set(unit.slice(unit.lastIndexOf("/") + 1), expected.slice(expected.lastIndexOf("/") + 1));
  }
  if (renames.size === 0) return renames;
  for (const file of repoFiles(root)) {
    if (file === "package-lock.json" || file.startsWith("public/js/vendor/")) continue;
    const bytes = readFileSync(join(root, file));
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    const next = rewriteRefs(text, renames);
    if (next !== text) writeFileSync(join(root, file), next);
  }
  return renames;
}

if (process.argv[1]?.endsWith("rehash-immutable.mjs")) {
  for (const [from, to] of rehash()) console.log(`${from} -> ${to}`);
}
