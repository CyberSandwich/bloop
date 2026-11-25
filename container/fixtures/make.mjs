// Writes the generated corpus into container/fixtures/generated/ (gitignored). Run: node container/fixtures/make.mjs
// The committed binaries (media/, macro/) are not made here; see container/README.md for their provenance.
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, createDeflateRaw } from "node:zlib";
import { docx, linkedOdt, linkedRtf, odfWithMacro, pdf, pptx } from "./lib.mjs";

/** Where the external-relationship fixtures point; the corpus runner listens here and must see nothing. */
export const CANARY = "http://127.0.0.1:8099";
/** Where the macro fixtures try to write; the corpus runner asserts it never appears. */
export const MACRO_SENTINEL = "/tmp/bloop-macro-ran";

const out = new URL("./generated/", import.meta.url);
mkdirSync(out, { recursive: true });
const put = (name, data) => writeFileSync(new URL(name, out), data);

const slide = (n, extra = {}) => ({ title: `Slide ${n}`, lines: [`Body of slide ${n}`], ...extra });
const deck = (count) => Array.from({ length: count }, (_, i) => slide(i + 1));

put("animated.pptx", pptx([slide(1, { motion: true }), slide(2), slide(3, { motion: true })]));
put(
  "notes.pptx",
  pptx([slide(1, { notes: "Open with the numbers.\nPause here." }), slide(2), slide(3, { notes: "x".repeat(5000) })]),
);
put("aptos.pptx", pptx([slide(1), slide(2)], { major: "Aptos Display", minor: "Aptos", runFont: "Aptos" }));
put("plain.pptx", pptx([slide(1), slide(2)]));
put("deck-20.pptx", pptx(deck(20)));
put("deck-100.pptx", pptx(deck(100)));
put("deck-300.pptx", pptx(deck(300)));
put(
  "hidden.pptx",
  pptx([slide(1), slide(2, { hidden: true, notes: "never shown" }), slide(3, { notes: "Third\tslide\nnote" })]),
);
put(
  "notes-late.pptx",
  pptx([slide(1), slide(2, { notes: "kept" }), slide(3), slide(4), slide(5, { notes: "past the page cap" })]),
);
put("external.pptx", pptx([slide(1)], { externalBase: CANARY }));
put("external.docx", docx("A document that links to the outside", { externalBase: CANARY }));
put("macro.odp", odfWithMacro("odp", MACRO_SENTINEL));
put("macro.odt", odfWithMacro("odt", MACRO_SENTINEL));
put("macro.ods", odfWithMacro("ods", MACRO_SENTINEL));
put("linked.odt", linkedOdt());
put("linked.docx", docx("Before the link.", { includeText: true }));
put("linked.rtf", linkedRtf());
put("pdf-js.pdf", pdf(["Active", "Content"], { active: true }));
put("big.pdf", pdf(["Over the chunk size"], { pad: 110 << 20 }));
put("pages-301.pdf", pdf(Array.from({ length: 301 }, (_, i) => `Page ${i + 1}`)));
put("bad-magic.pptx", "this is plain text, not a zip archive\n");

/** One honest zip entry that inflates to `size` zero bytes (about 1000:1), so the sizes in its headers are true. */
async function bombZip(size) {
  const deflate = createDeflateRaw({ level: 9 });
  const chunks = [];
  deflate.on("data", (c) => chunks.push(c));
  const finished = new Promise((resolve) => deflate.on("end", resolve));
  const block = Buffer.alloc(1 << 20);
  let crc = 0;
  for (let done = 0; done < size; done += block.length) {
    crc = crc32(block, crc);
    if (!deflate.write(block)) await new Promise((r) => deflate.once("drain", r));
  }
  deflate.end();
  await finished;
  const packed = Buffer.concat(chunks);
  const name = Buffer.from("ppt/media/bomb.bin");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(8, 8);
  head.writeUInt16LE(0x21, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(size, 22);
  head.writeUInt16LE(name.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  head.copy(dir, 6, 4, 30);
  const centralAt = head.length + name.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + name.length, 12);
  end.writeUInt32LE(centralAt, 16);
  return Buffer.concat([head, name, packed, dir, name, end]);
}

put("bomb.pptx", await bombZip(3 * 1024 ** 3));
