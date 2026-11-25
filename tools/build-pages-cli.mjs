// `node tools/build-pages-cli.mjs` writes the generated pages; `--check` writes nothing and exits 1 on drift.
import { sync } from "./build-pages.mjs";

const check = process.argv.includes("--check");
const { written, deleted } = sync({ check });
const lines = [...written.map((f) => `${f} (out of date)`), ...deleted.map((f) => `${f} (no content file builds it)`)];

if (lines.length === 0) process.exit(0);
if (check) {
  console.error(`Generated pages are out of date; run npm run build:pages and commit:\n  ${lines.join("\n  ")}`);
  process.exit(1);
}
console.log(`updated ${lines.length} file(s):\n  ${lines.join("\n  ")}`);
