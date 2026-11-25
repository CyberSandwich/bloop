import { describe, expect, it } from "vitest";
import {
  checkMagic,
  checkOoxml,
  checkText,
  detectMedia,
  externalRelationships,
  MAX_TEXT_BYTES,
} from "../../src/worker/seams/guest-drop/formats.ts";

const enc = new TextEncoder();
const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...enc.encode(p)] : p)));

const TYPES =
  '<Types xmlns="x"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';
const rels = (...rel: string[]) => `<?xml version="1.0"?><Relationships xmlns="x">${rel.join("")}</Relationships>`;
const internal = '<Relationship Id="rId1" Type="http://x/slide" Target="slides/slide1.xml"/>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const external = (type: string, extra = 'TargetMode="External"') =>
  `<Relationship Id="rId2" Type="${type}" Target="https://example.com/a" ${extra}/>`;
const link = (extra?: string) => external(`${REL}/hyperlink`, extra);
const NAMES = ["[Content_Types].xml", "ppt/presentation.xml", "_rels/.rels"];

describe("DROP-14 external: relationships", () => {
  it("passes a package whose relationships stay inside", () => {
    expect(checkOoxml(NAMES, TYPES, [rels(internal)])).toEqual({ ok: true });
  });

  it("allows an external hyperlink, in either namespace", () => {
    const strict = external("http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink");
    expect(checkOoxml(NAMES, TYPES, [rels(internal, link()), rels(strict)])).toEqual({ ok: true });
  });

  it.each(["oleObject", "attachedTemplate", "frame", "image", "audio", "video", "package", "externalLinkPath"])(
    "refuses an external %s relationship in any rels part",
    (kind) => {
      const verdict = checkOoxml(NAMES, TYPES, [rels(internal, link()), rels(external(`${REL}/${kind}`))]);
      expect(verdict).toMatchObject({ ok: false, error: "bad_structure", reason: "external relationship" });
    },
  );

  it("refuses an external relationship of an unknown or look-alike type", () => {
    for (const type of ["http://x/t", "", "http://evil.example/relationships/hyperlink", `${REL}/hyperlinks`]) {
      expect(checkOoxml(NAMES, TYPES, [rels(external(type))])).toMatchObject({ ok: false });
    }
  });

  it("refuses an external relationship whose mode is written in another form", () => {
    expect(checkOoxml(NAMES, TYPES, [rels(external(`${REL}/oleObject`, "TargetMode = 'External'"))])).toMatchObject({
      ok: false,
    });
  });

  it.each(["TargetMode = 'External'", 'targetmode="external"', 'TargetMode="External"'])(
    "reads the form %s",
    (mode) => {
      expect(externalRelationships(rels(link(mode)))).toEqual([
        { type: `${REL}/hyperlink`, target: "https://example.com/a" },
      ]);
    },
  );

  it("is not fooled by the word External elsewhere", () => {
    const named = '<Relationship Id="r" Type="http://x/t" Target="External.xml"/>';
    expect(externalRelationships(rels(named))).toEqual([]);
    expect(externalRelationships(rels(link('TargetMode="Internal"')))).toEqual([]);
  });
});

describe("DROP-14 external: macro-enabled packages", () => {
  const word = (ct: string) => `<Types><Override PartName="/word/document.xml" ContentType="${ct}"/></Types>`;

  it.each([
    "application/vnd.ms-word.document.macroEnabled.main+xml",
    "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  ])("refuses the content type %s whatever the extension", (ct) => {
    expect(checkOoxml(["[Content_Types].xml", "word/document.xml"], word(ct), [])).toMatchObject({
      ok: false,
      error: "macro_content",
    });
  });

  it("refuses a VBA project or ActiveX part under any folder", () => {
    for (const name of ["word/vbaProject.bin", "xl/vbaProject.bin", "ppt/activeX/activeX1.xml", "VBAPROJECT.BIN"]) {
      expect(checkOoxml([...NAMES, name], TYPES, [])).toMatchObject({ ok: false, reason: "macro part" });
    }
  });

  it("passes the macro-free types", () => {
    const plain = word("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
    expect(checkOoxml(["[Content_Types].xml", "word/document.xml"], plain, [])).toEqual({ ok: true });
  });
});

describe("DROP-15 magic: image and video brands", () => {
  const webp = bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ");
  const gif = bytes("GIF89a", [1, 0, 1, 0]);
  const heic = bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0], "mif1heic");
  const webm = bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0x82, 0x84],
    "webm",
  );

  it("accepts each format under its own kind", () => {
    expect(checkMagic(webp, "webp")).toEqual({ ok: true });
    expect(checkMagic(gif, "gif")).toEqual({ ok: true });
    expect(checkMagic(bytes("GIF87a", [1, 0, 1, 0]), "gif")).toEqual({ ok: true });
    expect(checkMagic(heic, "heic")).toEqual({ ok: true });
    expect(checkMagic(webm, "webm")).toEqual({ ok: true });
  });

  it("accepts the other HEIF major brands", () => {
    for (const brand of ["heix", "hevc", "mif1", "msf1"]) {
      expect(detectMedia(bytes([0, 0, 0, 24], `ftyp${brand}`, [0, 0, 0, 0]))).toBe("heic");
    }
  });

  it("refuses a file whose bytes say another format", () => {
    expect(checkMagic(gif, "webp")).toMatchObject({ ok: false, error: "bad_type" });
    expect(checkMagic(webp, "gif")).toMatchObject({ ok: false, error: "bad_type" });
    expect(checkMagic(webm, "heic")).toMatchObject({ ok: false, error: "bad_type" });
  });

  it("refuses a RIFF file that is not WebP", () => {
    expect(detectMedia(bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "))).toBeNull();
  });

  it("refuses Matroska, which shares the WebM header, and an MP4 brand", () => {
    const mkv = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x88], "matroska");
    expect(detectMedia(mkv)).toBeNull();
    expect(detectMedia(bytes([0, 0, 0, 24], "ftypisom", [0, 0, 0, 0], "isomiso2"))).toBeNull();
  });

  it("refuses short and empty input", () => {
    for (const head of [
      new Uint8Array(),
      bytes("RIFF"),
      bytes("GIF8"),
      bytes([0, 0, 0, 24], "ftyp"),
      bytes([0x1a, 0x45]),
    ]) {
      expect(detectMedia(head)).toBeNull();
    }
  });

  it("ignores a WebM doctype beyond the EBML header", () => {
    const late = bytes([0x1a, 0x45, 0xdf, 0xa3], new Array(80).fill(0), [0x42, 0x82, 0x84], "webm");
    expect(detectMedia(late)).toBeNull();
  });
});

describe("DROP-15 magic: text", () => {
  it("accepts UTF-8, including multi-byte text, a byte order mark and an empty file", () => {
    expect(checkText(enc.encode("plain é中\u{1f600}"))).toEqual({ ok: true });
    expect(checkText(bytes([0xef, 0xbb, 0xbf], "bom"))).toEqual({ ok: true });
    expect(checkText(new Uint8Array())).toEqual({ ok: true });
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(checkText(Uint8Array.from([0x68, 0xff, 0xfe]))).toMatchObject({
      ok: false,
      error: "bad_type",
      reason: "not UTF-8",
    });
    expect(checkText(Uint8Array.from([0xc3, 0x28]))).toMatchObject({ ok: false });
    expect(checkText(Uint8Array.from([0xed, 0xa0, 0x80]))).toMatchObject({ ok: false });
  });

  it("allows exactly 5 MB and refuses one byte more", () => {
    expect(checkText(new Uint8Array(MAX_TEXT_BYTES).fill(0x61))).toEqual({ ok: true });
    expect(checkText(new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x61))).toMatchObject({ ok: false, error: "too_large" });
  });
});
