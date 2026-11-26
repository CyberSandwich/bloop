// @ts-nocheck: a plain script that builds string templates; the unit test checks what it writes.
// Writes the sample decks the mock file source serves into test/fixtures/decks/:
// two minimal .pptx files (Office Open XML parts, zipped with node:zlib) and one .pdf (hand-written objects).
// Output is byte-for-byte reproducible: fixed zip timestamps, no random ids. Run: node tools/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { zip } from "./zip.mjs";

const out = new URL("../test/fixtures/decks/", import.meta.url);

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

const rels = (items) =>
  `${XML}<Relationships xmlns="${REL_NS}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

/** A placeholder shape. Position and size come from the layout and master. */
const placeholder = (id, name, ph, paragraphs) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs
    .map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(t)}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;

const emptyGroup = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

const slideXml = ({ title, lines }) =>
  `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${emptyGroup}${placeholder(2, "Title 1", 'type="title"', [title])}${placeholder(3, "Content 2", 'idx="1"', lines)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const frame = (id, name, ph, x, y, cx, cy, text, size) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const MASTER = `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyGroup}${frame(2, "Title Placeholder 1", 'type="title"', 457200, 274638, 8229600, 1143000, "Click to edit Master title style", 4400)}${frame(3, "Text Placeholder 2", 'type="body" idx="1"', 457200, 1600200, 8229600, 4525963, "Click to edit Master text styles", 2800)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${emptyGroup}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const fill = (c) => `<a:solidFill><a:schemeClr val="${c}"/></a:solidFill>`;
const THEME = `${XML}<a:theme xmlns:a="${NS_A}" name="Plain"><a:themeElements><a:clrScheme name="Plain"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Plain"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Plain"><a:fillStyleLst>${fill("phClr")}${fill("phClr")}${fill("phClr")}</a:fillStyleLst><a:lnStyleLst><a:ln w="9525">${fill("phClr")}</a:ln><a:ln w="25400">${fill("phClr")}</a:ln><a:ln w="38100">${fill("phClr")}</a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill("phClr")}${fill("phClr")}${fill("phClr")}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/** Entries of one deck: the fixed parts plus one slide part per slide. */
function pptxParts(slides) {
  const slideIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  const override = (path, type) =>
    `<Override PartName="${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
  return [
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override("/ppt/presentation.xml", "presentationml.presentation.main")}${override("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster")}${override("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout")}${override("/ppt/theme/theme1.xml", "theme")}${slides.map((_, i) => override(`/ppt/slides/slide${i + 1}.xml`, "presentationml.slide")).join("")}</Types>`,
    ],
    ["_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]])],
    [
      "ppt/presentation.xml",
      `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ...slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`]),
        [`rId${slides.length + 2}`, "theme", "theme/theme1.xml"],
      ]),
    ],
    ["ppt/slideMasters/slideMaster1.xml", MASTER],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "theme", "../theme/theme1.xml"],
      ]),
    ],
    ["ppt/slideLayouts/slideLayout1.xml", LAYOUT],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    ],
    ["ppt/theme/theme1.xml", THEME],
    ...slides.flatMap((s, i) => [
      [`ppt/slides/slide${i + 1}.xml`, slideXml(s)],
      [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]])],
    ]),
  ];
}

/** One page per entry: a title and lines of Helvetica text. Offsets in the xref table are computed, not typed. */
function pdf(pages) {
  const pdfText = (s) => s.replace(/[\\()]/g, "\\$&");
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = pages.map(({ title, lines }) => {
    const text = [
      `BT /F1 28 Tf 72 700 Td (${pdfText(title)}) Tj ET`,
      ...lines.map((l, i) => `BT /F1 16 Tf 72 ${650 - i * 28} Td (${pdfText(l)}) Tj ET`),
    ].join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] >>`;
  let body = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = Buffer.byteLength(body);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const decks = {
  "sample-deck.pptx": zip(
    pptxParts([
      { title: "Sample deck", lines: ["Shown from a phone-approved link", "Three slides, plain text"] },
      { title: "Why it opens", lines: ["The screen never signs in", "The phone approves one file"] },
      { title: "Thank you", lines: ["Questions"] },
    ]),
  ),
  "quarterly-review.pptx": zip(
    pptxParts([
      { title: "Quarterly review", lines: ["Results, risks and next steps"] },
      { title: "Results", lines: ["Numbers are sample text", "Nothing here is real data"] },
    ]),
  ),
  "sample-handout.pdf": pdf([
    { title: "Sample handout", lines: ["A one-page PDF for the demo", "It stands in for a slide export"] },
    { title: "Page two", lines: ["Plain text only"] },
  ]),
};

mkdirSync(out, { recursive: true });
for (const [name, bytes] of Object.entries(decks)) {
  writeFileSync(new URL(name, out), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
