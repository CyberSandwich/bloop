// `node tools/build-pages-cli.mjs` writes the generated pages; `--check` writes nothing and exits 1 on drift;
// `--launch` writes nothing and exits 1 while an open document still carries the placeholder date.
import { placeholderDates, sync } from "./build-pages.mjs";

if (process.argv.includes("--launch")) {
  const left = placeholderDates();
  if (left.length === 0) process.exit(0);
  console.error(`Open documents still carry the placeholder date:\n  ${left.join("\n  ")}`);
  process.exit(1);
}

const check = process.argv.includes("--check");
const { written, deleted } = sync({ check });
const lines = [...written.map((f) => `${f} (out of date)`), ...deleted.map((f) => `${f} (no content file builds it)`)];

if (lines.length === 0) process.exit(0);
if (check) {
  console.error(`Generated pages are out of date; run npm run build:pages and commit:\n  ${lines.join("\n  ")}`);
  process.exit(1);
}
console.log(`updated ${lines.length} file(s):\n  ${lines.join("\n  ")}`);
