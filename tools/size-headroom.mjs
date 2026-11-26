// A visible warning when a CSS budget is nearly full. CI measures gzip with an x86 Node whose bundled zlib can come out
// about 20 bytes larger than this machine's on the same file, so a CSS entry within 25 bytes of its limit may pass
// here and fail there. Warns only; CI's number is the one that counts.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MARGIN = 25;

/**
 * @param {{ name: string, size: number, sizeLimit: number }[]} entries size-limit's `--json` output
 * @returns {string[]} one line per CSS entry within `MARGIN` bytes of its limit
 */
export function tightCss(entries) {
  return entries
    .filter((e) => /\bCSS\b/.test(e.name) && e.sizeLimit - e.size < MARGIN)
    .map(
      (e) =>
        `${e.name}: ${e.size} of ${e.sizeLimit} bytes. CI's x86 zlib can measure up to about 20 bytes more than this machine; CI decides.`,
    );
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const json = execFileSync("npx", ["size-limit", "--json"], { encoding: "utf8", maxBuffer: 1 << 24 });
  for (const line of tightCss(JSON.parse(json))) console.warn(`size warning: ${line}`);
}
