// Vendors a fresh uqr dist/index.mjs into public/js/vendor/uqr.js (ADR 0001, QR row) as a trimmed copy. Line based
// only: a line goes when it is wholly a `//` comment or wholly one `/* ... */` comment; every other line stays byte for
// byte, and the license block at the top of the vendored file is kept.
// usage: node tools/trim-uqr.mjs <path to uqr dist/index.mjs> <version>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [source, version] = process.argv.slice(2);
if (!source || !version) throw new Error("usage: node tools/trim-uqr.mjs <dist/index.mjs> <version>");
const target = fileURLToPath(new URL("../public/js/vendor/uqr.js", import.meta.url));
const current = readFileSync(target, "utf8");
const lines = readFileSync(source, "utf8").split("\n");

// Inside a template literal that spans lines, a line starting with `//` is code: refuse such a source.
if (lines.some((l) => (l.match(/`/g) ?? []).length % 2 === 1)) {
  throw new Error("a template literal spans lines: trim by hand and check the diff");
}
const comment = (/** @type {string} */ l) => /^\s*\/\//.test(l) || /^\s*\/\*(?!!)(?:(?!\*\/).)*\*\/\s*$/.test(l);
const kept = lines.filter((l) => !comment(l));

// The text renderers run from getDataAt to the export line; bloop calls encode alone (core/qr.js), so they go whole
// and the export names encode only. A source whose tail differs is refused rather than cut by guess.
const RENDERERS = ["getDataAt", "renderUnicode", "renderANSI", "renderUnicodeCompact", "escapeAttr", "renderSVG"];
const from = kept.findIndex((l) => l.startsWith("function getDataAt("));
const to = kept.findIndex((l) => l.startsWith("export {"));
const declared = kept.slice(from, to).flatMap((l) => l.match(/^function (\w+)\(/)?.[1] ?? []);
const rest = [...kept.slice(0, from), ...kept.slice(to + 1)];
if (
  from < 0 ||
  to < from ||
  declared.join() !== RENDERERS.join() ||
  rest.some((l) => RENDERERS.some((n) => l.includes(n)))
) {
  throw new Error("uqr's renderers are not where this script expects them: trim by hand and check the diff");
}
const code = [...kept.slice(0, from), "export { encode };", ...kept.slice(to + 1)];

// The license block: everything after the first line of the vendored header, up to its end.
const license = current.slice(current.indexOf("\n"), current.indexOf("*/") + 2);
const head = `/*! uqr ${version} (https://github.com/unjs/uqr), vendored from dist/index.mjs by tools/trim-uqr.mjs (the browser JS budget): whole-line comments and the text renderers removed; every other line unmodified.`;
writeFileSync(target, `${head}${license}\n${code.join("\n")}`);

// Read back: the header slicing kept the body whole, and the file parses (node --check is the guard that matters).
const written = readFileSync(target, "utf8");
const body = written.slice(written.indexOf("*/") + 3);
const parses = spawnSync(process.execPath, ["--check", target]).status === 0;
if (body !== code.join("\n") || !parses) {
  writeFileSync(target, current);
  throw new Error("the trimmed file changed a code line or does not parse; restored the old one");
}
