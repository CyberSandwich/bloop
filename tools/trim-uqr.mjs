// Vendors a fresh uqr dist/index.mjs into public/js/vendor/uqr.js (ADR 0001, QR row) as a trimmed copy: every
// whole-line comment goes, the code stays byte for byte, and the license block at the top of the vendored file is kept.
// The comments cost about 1.3 kB of the browser JS budget.
// usage: node tools/trim-uqr.mjs <path to uqr dist/index.mjs> <version>
import { readFileSync, writeFileSync } from "node:fs";

const [source, version] = process.argv.slice(2);
if (!source || !version) throw new Error("usage: node tools/trim-uqr.mjs <dist/index.mjs> <version>");
const target = new URL("../public/js/vendor/uqr.js", import.meta.url);
const current = readFileSync(target, "utf8");
// The license block: everything after the first line of the vendored header, up to its end.
const license = current.slice(current.indexOf("\n"), current.indexOf("*/") + 2);
const body = readFileSync(source, "utf8")
  .replace(/^[ \t]*\/\*(?!!)[\s\S]*?\*\/[ \t]*\n/gm, "")
  .replace(/^[ \t]*\/\/.*\n/gm, "");
const head = `/*! uqr ${version} (https://github.com/unjs/uqr), vendored from dist/index.mjs with only its comments removed by tools/trim-uqr.mjs (the browser JS budget); the code is unmodified.`;
writeFileSync(target, `${head}${license}\n${body}`);
