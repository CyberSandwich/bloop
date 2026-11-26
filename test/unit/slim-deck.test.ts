import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { zip } from "../../tools/zip.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const TOOL = fileURLToPath(new URL("../../tools/slim-deck.py", import.meta.url));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: [string, string, string][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`;
const override = (path: string, type: string) =>
  `<Override PartName="${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;

/** A deck with two layouts (slide 1 uses the first), media only the second reaches, a thumbnail and identity fields. */
const fixture = (): Buffer =>
  zip([
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${override("/ppt/presentation.xml", "presentationml.presentation.main")}${override("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster")}${override("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout")}${override("/ppt/slideLayouts/slideLayout2.xml", "presentationml.slideLayout")}${override("/ppt/slides/slide1.xml", "presentationml.slide")}${override("/ppt/notesSlides/notesSlide1.xml", "presentationml.notesSlide")}${override("/docProps/app.xml", "extended-properties")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      rels([
        ["rId1", `${REL}/officeDocument`, "ppt/presentation.xml"],
        [
          "rId2",
          "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
          "docProps/core.xml",
        ],
        ["rId3", `${REL}/extended-properties`, "docProps/app.xml"],
        [
          "rId4",
          "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail",
          "docProps/thumbnail.jpeg",
        ],
      ]),
    ],
    ["docProps/thumbnail.jpeg", "not a picture"],
    [
      "docProps/core.xml",
      `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>Someone Real</dc:creator><cp:lastModifiedBy>Someone Real</cp:lastModifiedBy><cp:revision>2</cp:revision></cp:coreProperties>`,
    ],
    [
      "docProps/app.xml",
      `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Acme</Company><Manager>Boss</Manager><Slides>1</Slides></Properties>`,
    ],
    [
      "ppt/presentation.xml",
      `${XML}<p:presentation xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId1", `${REL}/slideMaster`, "slideMasters/slideMaster1.xml"],
        ["rId2", `${REL}/slide`, "slides/slide1.xml"],
      ]),
    ],
    [
      "ppt/slideMasters/slideMaster1.xml",
      `${XML}<p:sldMaster xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst></p:sldMaster>`,
    ],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      rels([
        ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
        ["rId2", `${REL}/slideLayout`, "../slideLayouts/slideLayout2.xml"],
      ]),
    ],
    [
      "ppt/slideLayouts/slideLayout1.xml",
      `${XML}<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    ],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      rels([["rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml"]]),
    ],
    [
      "ppt/slideLayouts/slideLayout2.xml",
      `${XML}<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    ],
    [
      "ppt/slideLayouts/_rels/slideLayout2.xml.rels",
      rels([
        ["rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml"],
        ["rId2", `${REL}/image`, "../media/only-layout-2.png"],
      ]),
    ],
    ["ppt/media/only-layout-2.png", "png bytes"],
    ["ppt/slides/slide1.xml", `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`],
    [
      "ppt/slides/_rels/slide1.xml.rels",
      rels([
        ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
        ["rId2", `${REL}/notesSlide`, "../notesSlides/notesSlide1.xml"],
      ]),
    ],
    [
      "ppt/notesSlides/notesSlide1.xml",
      `${XML}<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><a:t xmlns:a="a">Say hello</a:t></p:notes>`,
    ],
    ["ppt/notesSlides/_rels/notesSlide1.xml.rels", rels([["rId1", `${REL}/slide`, "../slides/slide1.xml"]])],
  ]);

const dir = mkdtempSync(join(tmpdir(), "slim-deck-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tools/slim-deck.py", { timeout: SPAWN_TIMEOUT }, () => {
  const input = join(dir, "in.pptx");
  const output = join(dir, "out.pptx");
  writeFileSync(input, fixture());
  const printed = execFileSync("python3", ["-I", TOOL, input, output], { encoding: "utf8" });
  const names = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" }).trim().split("\n");
  const part = (name: string) =>
    execFileSync("unzip", ["-p", output, name.replace(/[[\]]/g, "\\$&")], { encoding: "utf8" });

  it("drops the layout no slide uses, the media only it reached and the preview picture", () => {
    expect(printed).toMatch(/^\d+ -> \d+ bytes/);
    expect(names).toContain("ppt/slideLayouts/slideLayout1.xml");
    expect(names).not.toContain("ppt/slideLayouts/slideLayout2.xml");
    expect(names).not.toContain("ppt/media/only-layout-2.png");
    expect(names).not.toContain("docProps/thumbnail.jpeg");
    expect(part("ppt/slideMasters/slideMaster1.xml")).not.toContain('r:id="rId2"');
    expect(part("ppt/slideMasters/_rels/slideMaster1.xml.rels")).not.toContain("slideLayout2");
    expect(part("[Content_Types].xml")).not.toContain("slideLayout2");
    expect(part("_rels/.rels")).not.toContain("thumbnail");
  });

  it("keeps the slides and their notes, and clears who made the deck", () => {
    expect(names).toContain("ppt/slides/slide1.xml");
    expect(part("ppt/notesSlides/notesSlide1.xml")).toContain("Say hello");
    expect(part("docProps/core.xml")).not.toMatch(/Someone Real|dc:creator|lastModifiedBy/);
    expect(part("docProps/app.xml")).not.toMatch(/Acme|Boss|Company|Manager/);
    expect(part("docProps/core.xml")).toContain("<cp:revision>2</cp:revision>");
  });

  it("writes the same bytes every run, with the content types first", () => {
    const again = join(dir, "again.pptx");
    execFileSync("python3", ["-I", TOOL, input, again]);
    expect(readFileSync(again).equals(readFileSync(output))).toBe(true);
    expect(names[0]).toBe("[Content_Types].xml");
  });

  it("refuses a package whose relationship points at a missing part", () => {
    const broken = join(dir, "broken.pptx");
    writeFileSync(
      broken,
      zip([
        ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`],
        ["_rels/.rels", rels([["rId1", `${REL}/officeDocument`, "ppt/presentation.xml"]])],
      ]),
    );
    expect(() => execFileSync("python3", ["-I", TOOL, broken, join(dir, "x.pptx")], { stdio: "pipe" })).toThrow();
  });
});
