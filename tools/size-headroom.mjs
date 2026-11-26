// `npm run size` after the build: runs size-limit once, fails on any entry over its limit, and warns, as a visible line,
// when a CSS entry is near its limit. CI measures gzip with an x86 Node whose bundled zlib can come out about 20 bytes
// larger than this machine's on the same file, so a CSS entry within 25 bytes of its limit may pass here and fail there.
// The warning is advice; CI's number is the one that counts.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MARGIN = 25;

/**
 * @param {{ name: string, size: number, sizeLimit: number, passed: boolean }[]} entries size-limit's `--json` output
 * @returns {{ failures: string[], warnings: string[] }} entries over their limit, and CSS entries within `MARGIN` of it
 */
export function check(entries) {
  const failures = entries.filter((e) => !e.passed).map((e) => `${e.name}: ${e.size} over ${e.sizeLimit} bytes`);
  const warnings = entries
    .filter((e) => e.passed && /\bCSS\b/.test(e.name) && e.sizeLimit - e.size < MARGIN)
    .map(
      (e) =>
        `${e.name}: ${e.size} of ${e.sizeLimit} bytes. CI's x86 zlib can measure up to about 20 bytes more than this machine; CI decides.`,
    );
  return { failures, warnings };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // size-limit exits 1 when an entry is over, still printing its JSON; only an unreadable answer is its own failure.
  const run = spawnSync("npx", ["size-limit", "--json"], { encoding: "utf8", maxBuffer: 1 << 24 });
  let entries;
  try {
    entries = JSON.parse(run.stdout);
  } catch {
    console.error(`size-limit gave no JSON:\n${run.stdout}${run.stderr}`);
    process.exit(1);
  }
  const { failures, warnings } = check(entries);
  for (const line of failures) console.error(`size limit exceeded: ${line}`);
  for (const line of warnings) console.warn(`size warning: ${line}`);
  console.log(
    `size: ${entries.length} entries, ${failures.length} over their limit, ${warnings.length} near a CSS limit`,
  );
  process.exit(failures.length > 0 ? 1 : 0);
}
