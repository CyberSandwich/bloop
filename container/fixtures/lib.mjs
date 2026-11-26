// Builders for the fixture corpus: a zip writer, minimal OOXML and ODF packages, and a hand-written PDF.
// Every output is byte-for-byte reproducible (fixed timestamps, no random ids).
import { crc32, deflateRawSync } from "node:zlib";

export const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A zip from [name, string|Buffer] entries; `store` names are written uncompressed (ODF mimetype). */
export function zip(entries, { store = [] } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(data);
    const stored = store.includes(name);
    const packed = stored ? raw : deflateRawSync(raw, { level: 9 });
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    head.copy(dir, 6, 4, 30);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, packed);
    central.push(dir, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const rels = (items) =>
  `${XML}<Relationships xmlns="${REL_NS}">${items
    .map(
      ([id, type, target, mode]) =>
        `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${esc(target)}"${mode ? ` TargetMode="${mode}"` : ""}/>`,
    )
    .join("")}</Relationships>`;

const override = (path, type) =>
  `<Override PartName="${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;

const emptyGroup = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

const fill = (c) => `<a:solidFill><a:schemeClr val="${c}"/></a:solidFill>`;

const theme = (name, major, minor) =>
  `${XML}<a:theme xmlns:a="${NS_A}" name="${name}"><a:themeElements><a:clrScheme name="Plain"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Plain"><a:majorFont><a:latin typeface="${major}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${minor}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Plain"><a:fillStyleLst>${fill("phClr")}${fill("phClr")}${fill("phClr")}</a:fillStyleLst><a:lnStyleLst><a:ln w="9525">${fill("phClr")}</a:ln><a:ln w="25400">${fill("phClr")}</a:ln><a:ln w="38100">${fill("phClr")}</a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill("phClr")}${fill("phClr")}${fill("phClr")}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const frame = (id, name, ph, x, y, cx, cy, text, size) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const MASTER = `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyGroup}${frame(2, "Title Placeholder 1", 'type="title"', 457200, 274638, 8229600, 1143000, "Click to edit Master title style", 4400)}${frame(3, "Text Placeholder 2", 'type="body" idx="1"', 457200, 1600200, 8229600, 4525963, "Click to edit Master text styles", 2800)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${emptyGroup}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const NOTES_MASTER = `${XML}<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyGroup}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

const para = (t, font) =>
  `<a:p><a:r><a:rPr lang="en-US">${font ? `<a:latin typeface="${esc(font)}"/>` : ""}</a:rPr><a:t>${esc(t)}</a:t></a:r></a:p>`;

const placeholder = (id, name, ph, paragraphs, font) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.map((t) => para(t, font)).join("")}</p:txBody></p:sp>`;

const TRANSITION = '<p:transition spd="med"><p:fade/></p:transition>';
const TIMING = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="3"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="3" grpId="0" build="p"/></p:bldLst></p:timing>`;

const linkedPicture = (rid) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Linked picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="5200000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

const hyperlinkRun = (rid) =>
  `<a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="${rid}"/></a:rPr><a:t>A link that must not be followed</a:t></a:r></a:p>`;

function notesSlideXml(n, text) {
  const body = text
    .split("\n")
    .map((t) => para(t))
    .join("");
  return `${XML}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${emptyGroup}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{00000000-1234-1234-1234-123412341234}" type="slidenum"><a:rPr lang="en-US"/><a:t>${n}</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

/**
 * One deck. slides: [{title, lines, notes?, motion?, hidden?}]. Options: major/minor theme fonts,
 * runFont (a latin typeface on every run), externalBase (adds a linked picture and a hyperlink
 * that point at that URL with TargetMode="External").
 */
export function pptx(slides, { major = "Arial", minor = "Arial", runFont, externalBase } = {}) {
  const hasNotes = slides.some((s) => s.notes);
  const nm = slides.length + 2; // rId of the notes master in presentation.xml.rels
  const parts = [
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${override("/ppt/presentation.xml", "presentationml.presentation.main")}${override("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster")}${override("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout")}${override("/ppt/theme/theme1.xml", "theme")}${hasNotes ? `${override("/ppt/notesMasters/notesMaster1.xml", "presentationml.notesMaster")}${override("/ppt/theme/theme2.xml", "theme")}` : ""}${slides
        .map(
          (s, i) =>
            override(`/ppt/slides/slide${i + 1}.xml`, "presentationml.slide") +
            (s.notes ? override(`/ppt/notesSlides/notesSlide${i + 1}.xml`, "presentationml.notesSlide") : ""),
        )
        .join("")}</Types>`,
    ],
    ["_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]])],
    [
      "ppt/presentation.xml",
      `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${nm}"/></p:notesMasterIdLst>` : ""}<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ...slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`]),
        ...(hasNotes ? [[`rId${nm}`, "notesMaster", "notesMasters/notesMaster1.xml"]] : []),
        [`rId${nm + 1}`, "theme", "theme/theme1.xml"],
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
    ["ppt/theme/theme1.xml", theme("Plain", major, minor)],
  ];
  if (hasNotes) {
    parts.push(["ppt/notesMasters/notesMaster1.xml", NOTES_MASTER]);
    parts.push(["ppt/notesMasters/_rels/notesMaster1.xml.rels", rels([["rId1", "theme", "../theme/theme2.xml"]])]);
    parts.push(["ppt/theme/theme2.xml", theme("Notes", major, minor)]);
  }
  slides.forEach((s, i) => {
    const n = i + 1;
    const links = externalBase
      ? [
          ["rId2", "image", `${externalBase}/linked.png`, "External"],
          ["rId3", "hyperlink", `${externalBase}/hyperlink`, "External"],
        ]
      : [];
    const shapes = [
      placeholder(2, "Title 1", 'type="title"', [s.title], runFont),
      placeholder(3, "Content 2", 'idx="1"', s.lines, runFont),
      ...(externalBase ? [linkedPicture("rId2")] : []),
    ].join("");
    const extra = externalBase
      ? `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Link"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="2000000" y="5200000"/><a:ext cx="6000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${hyperlinkRun("rId3")}</p:txBody></p:sp>`
      : "";
    parts.push([
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"${s.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${emptyGroup}${shapes}${extra}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${s.motion ? TRANSITION + TIMING : ""}</p:sld>`,
    ]);
    parts.push([
      `ppt/slides/_rels/slide${n}.xml.rels`,
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ...links,
        ...(s.notes ? [["rId4", "notesSlide", `../notesSlides/notesSlide${n}.xml`]] : []),
      ]),
    ]);
    if (s.notes) {
      parts.push([`ppt/notesSlides/notesSlide${n}.xml`, notesSlideXml(n, s.notes)]);
      parts.push([
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        rels([
          ["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
          ["rId2", "slide", `../slides/slide${n}.xml`],
        ]),
      ]);
    }
  });
  return zip(parts);
}

/** The file the link fixtures point at (the corpus creates it inside the container) and the text it holds. */
export const LINK_PATH = "/tmp/bloop-link-marker.txt";
export const LINK_MARKER = "BLOOP-LINK-MARKER-7f3a91";
/** The picture linked-image.odt points at; the corpus makes a real PNG there inside the container. */
export const LINK_IMAGE_PATH = "/tmp/bloop-link-image.png";

/** A one-paragraph .rtf with an INCLUDETEXT field that names LINK_PATH. */
export const linkedRtf = () =>
  Buffer.from(
    `{\\rtf1\\ansi\\deff0 Before the link.\\par {\\field{\\*\\fldinst INCLUDETEXT "${LINK_PATH}"}{\\fldrslt cached text}}\\par}\n`,
  );

/**
 * A one-paragraph .docx; externalBase adds a linked picture and an attached template pointing at it,
 * includeText a complex INCLUDETEXT field that names that local file.
 */
export function docx(text, { externalBase, includeText } = {}) {
  const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
  const picture = externalBase
    ? `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Linked picture"/><a:graphic xmlns:a="${NS_A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="linked.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    : "";
  const include = includeText
    ? `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDETEXT "${LINK_PATH}" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>cached text</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    : "";
  const parts = [
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`,
    ],
    ["_rels/.rels", rels([["rId1", "officeDocument", "word/document.xml"]])],
    [
      "word/document.xml",
      `${XML}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}"><w:body><w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p>${picture}${include}</w:body></w:document>`,
    ],
    [
      "word/settings.xml",
      `${XML}<w:settings xmlns:w="${NS_W}" xmlns:r="${NS_R}">${externalBase ? '<w:attachedTemplate r:id="rId1"/>' : ""}</w:settings>`,
    ],
    [
      "word/_rels/document.xml.rels",
      rels([
        ["rId1", "settings", "settings.xml"],
        ...(externalBase ? [["rId2", "image", `${externalBase}/linked.png`, "External"]] : []),
      ]),
    ],
  ];
  if (externalBase) {
    parts.push([
      "word/_rels/settings.xml.rels",
      rels([["rId1", "attachedTemplate", `${externalBase}/template.dotm`, "External"]]),
    ]);
  }
  return zip(parts);
}

/** A PDF with page text, optionally every kind of active content the plan refuses, and `pad` bytes in an unreferenced stream. */
export function pdf(pages, { active = false, pad = 0 } = {}) {
  const text = (s) => s.replace(/[\\()]/g, "\\$&");
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const js = active ? add("<< /S /JavaScript /JS (app.alert\\('bloop-pdf-js'\\);) >>") : 0;
  const launch = active ? add("<< /S /Launch /F (cmd.exe) >>") : 0;
  const embedded = active ? add("<< /Type /EmbeddedFile /Length 5 >>\nstream\nhello\nendstream") : 0;
  const spec = active ? add(`<< /Type /Filespec /F (a.txt) /EF << /F ${embedded} 0 R >> >>`) : 0;
  const kids = pages.map((title, i) => {
    const body = `BT /F1 36 Tf 72 400 Td (${text(title)}) Tj ET`;
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    const aa = active && i === 0 ? ` /AA << /O ${launch} 0 R >>` : "";
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 792 446] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >>${aa} >>`,
    );
  });
  if (pad) add(`<< /Length ${pad} >>\nstream\n${" ".repeat(pad)}\nendstream`);
  const activeKeys = active
    ? ` /OpenAction ${js} 0 R /Names << /EmbeddedFiles << /Names [(a.txt) ${spec} 0 R] >> >>`
    : "";
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R${activeKeys} >>`;
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

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dom="http://www.w3.org/2001/xml-events" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" xmlns:ooo="http://openoffice.org/2004/office" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';

/** The Basic module every macro fixture carries: on open it writes `sentinel`. */
export const macroModule = (sentinel) =>
  `${XML}<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd"><script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">Sub Main\n  Dim n As Integer\n  n = FreeFile\n  Open "${sentinel}" For Output As #n\n  Print #n, "the macro ran"\n  Close #n\nEnd Sub\n</script:module>`;

/**
 * An .odt that links a file: a section whose source is LINK_PATH (updating it replaces "cached text" with the
 * file's content), or with `image`, a picture whose target is `href`.
 */
export function linkedOdt({ href = `file://${LINK_PATH}`, image = false } = {}) {
  const mime = "application/vnd.oasis.opendocument.text";
  const body = image
    ? `<text:p>Before the link.<draw:frame draw:name="img" text:anchor-type="as-char" svg:width="2cm" svg:height="2cm"><draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`
    : `<text:p>Before the link.</text:p><text:section text:name="Linked1"><text:section-source xlink:href="${href}" xlink:type="simple" xlink:show="embed" text:filter-name="Text"/><text:p>cached text</text:p></text:section>`;
  const content = `${XML}<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const manifest = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return zip(
    [
      ["mimetype", mime],
      ["content.xml", content],
      ["META-INF/manifest.xml", manifest],
    ],
    { store: ["mimetype"] },
  );
}

/** An ODF text or presentation file whose Basic macro is bound to the document-open event. */
export function odfWithMacro(kind, sentinel) {
  const mime =
    kind === "odp"
      ? "application/vnd.oasis.opendocument.presentation"
      : kind === "ods"
        ? "application/vnd.oasis.opendocument.spreadsheet"
        : "application/vnd.oasis.opendocument.text";
  const body =
    kind === "odp"
      ? '<office:presentation><draw:page draw:name="page1"><draw:frame draw:id="id1" svg:width="20cm" svg:height="3cm" svg:x="2cm" svg:y="2cm" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"><draw:text-box><text:p>A deck with an auto-open macro</text:p></draw:text-box></draw:frame></draw:page></office:presentation>'
      : kind === "ods"
        ? '<office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell office:value-type="string"><text:p>A sheet with an auto-open macro</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>'
        : "<office:text><text:p>A document with an auto-open macro</text:p></office:text>";
  const content = `${XML}<office:document-content ${ODF_NS} office:version="1.3"><office:scripts><office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document" xlink:type="simple"/></office:event-listeners></office:scripts><office:body>${body}</office:body></office:document-content>`;
  const entry = (path, type) => `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>`;
  const manifest = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">${entry("/", mime)}${entry("content.xml", "text/xml")}${entry("Basic/", "")}${entry("Basic/Standard/", "")}${entry("Basic/script-lc.xml", "text/xml")}${entry("Basic/Standard/script-lb.xml", "text/xml")}${entry("Basic/Standard/Module1.xml", "text/xml")}</manifest:manifest>`;
  const lc = `${XML}<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd"><library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink"><library:library library:name="Standard" library:link="false"/></library:libraries>`;
  const lb = `${XML}<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd"><library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false"><library:element library:name="Module1"/></library:library>`;
  return zip(
    [
      ["mimetype", mime],
      ["content.xml", content],
      ["META-INF/manifest.xml", manifest],
      ["Basic/script-lc.xml", lc],
      ["Basic/Standard/script-lb.xml", lb],
      ["Basic/Standard/Module1.xml", macroModule(sentinel)],
    ],
    { store: ["mimetype"] },
  );
}
