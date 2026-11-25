// Adds VBA project storages to a .doc, .xls or .ppt that LibreOffice wrote, so the file carries what
// a macro-bearing Office file carries in its compound file directory. LibreOffice cannot write a VBA
// project from an ODF Basic library, and nothing here is executable: the streams hold placeholder text.
// Usage: node inject-vba.mjs <in> <out>
import { readFileSync, writeFileSync } from "node:fs";
import { find, readCfb, writeCfb } from "./cfb.mjs";

const stream = (name, text) => ({ name, type: "stream", children: [], data: Buffer.from(text, "latin1") });
const project = () => ({
  name: "VBA",
  type: "storage",
  children: [
    stream("dir", "synthetic fixture: not a compressed VBA directory stream"),
    stream("_VBA_PROJECT", "synthetic fixture"),
    stream(
      "Module1",
      'Attribute VB_Name = "Module1"\nSub Auto_Open()\n  Open "/tmp/bloop-macro-ran" For Output As #1\nEnd Sub\n',
    ),
  ],
});

/** Returns the bytes of the file with `_VBA_PROJECT_CUR/VBA` and `Macros/VBA` added. */
export function injectVba(buf) {
  const root = readCfb(buf);
  for (const top of ["_VBA_PROJECT_CUR", "Macros"]) {
    if (find(root, [top])) continue;
    root.children.push({ name: top, type: "storage", children: [project()] });
  }
  return writeCfb(root);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [input, output] = process.argv.slice(2);
  writeFileSync(output, injectVba(readFileSync(input)));
}
