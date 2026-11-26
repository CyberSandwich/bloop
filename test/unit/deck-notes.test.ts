import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DECK_PAGES } from "../../src/shared/demo-catalog.ts";
import { zip } from "../../tools/zip.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const TOOL = fileURLToPath(new URL("../../tools/deck-notes.py", import.meta.url));
const FILES = fileURLToPath(new URL("../../src/worker/seams/file-source/demo-files/", import.meta.url));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const rels = (items: [string, string, string][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`;
const shape = (type: string, body: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
const notes = (...shapes: string[]) =>
  `${XML}<p:notes ${NS}><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:notes>`;

/** Slide order is slide3, slide1, slide2: not the file order. Slide 2 has no notes slide; slide 3's body is empty. */
const fixture = (): Buffer =>
  zip([
    ["_rels/.rels", rels([["rId1", `${REL}/officeDocument`, "ppt/presentation.xml"]])],
    [
      "ppt/presentation.xml",
      `${XML}<p:presentation xmlns:r="${REL}" ${NS}><p:sldIdLst><p:sldId id="258" r:id="rId3"/><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId1", `${REL}/slide`, "slides/slide1.xml"],
        ["rId2", `${REL}/slide`, "slides/slide2.xml"],
        ["rId3", `${REL}/slide`, "slides/slide3.xml"],
      ]),
    ],
    ...[1, 2, 3].map((n): [string, string] => [`ppt/slides/slide${n}.xml`, `${XML}<p:sld ${NS}/>`]),
    ["ppt/slides/_rels/slide1.xml.rels", rels([["rId1", `${REL}/notesSlide`, "../notesSlides/notesSlide1.xml"]])],
    ["ppt/slides/_rels/slide3.xml.rels", rels([["rId1", `${REL}/notesSlide`, "../notesSlides/notesSlide3.xml"]])],
    [
      "ppt/notesSlides/notesSlide1.xml",
      notes(
        shape("sldNum", "<a:p><a:r><a:t>7</a:t></a:r></a:p>"),
        shape(
          "body",
          "<a:p><a:r><a:t>Open with </a:t></a:r><a:r><a:t>the story.</a:t></a:r></a:p><a:p><a:r><a:t>Then</a:t></a:r><a:br/><a:r><a:t>the ask.</a:t></a:r></a:p>",
        ),
      ),
    ],
    ["ppt/notesSlides/notesSlide3.xml", notes(shape("body", "<a:p><a:endParaRPr/></a:p>"))],
  ]);

const dir = mkdtempSync(join(tmpdir(), "deck-notes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const extract = (pptx: string) => {
  const out = join(dir, "out.json");
  execFileSync("python3", ["-I", TOOL, pptx, out]);
  return JSON.parse(readFileSync(out, "utf8")) as string[];
};

describe("tools/deck-notes.py", { timeout: SPAWN_TIMEOUT }, () => {
  it("gives one string per slide in slide order: the body text only, joined by newlines, empty when there are none", () => {
    const input = join(dir, "in.pptx");
    writeFileSync(input, fixture());
    expect(extract(input)).toEqual(["", "Open with the story.\nThen\nthe ask.", ""]);
  });

  it("the committed demo-notes.json is what the committed deck says, one note per page", () => {
    const committed = JSON.parse(readFileSync(`${FILES}demo-notes.json`, "utf8"));
    expect(committed).toEqual(extract(`${FILES}demo-deck.pptx`));
    expect(committed).toHaveLength(DECK_PAGES);
  });
});
