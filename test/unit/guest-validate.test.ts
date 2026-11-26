import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { buildZip, concat, reader, validDeck, validJpeg, validPdf, validPng, validVideo } from "../zip-builder.ts";

const enc = new TextEncoder();
const deckCheck = (b: Uint8Array) => validate(reader(b), "pptx");
const pdfCheck = (b: Uint8Array) => validate(reader(b), "pdf");
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/decks/${name}`, import.meta.url)));

describe("DROP-02 type: accepted files", () => {
  it("accepts a minimal deck and a minimal PDF", async () => {
    expect(await deckCheck(validDeck())).toEqual({ ok: true, type: "pptx" });
    expect(await pdfCheck(validPdf())).toEqual({ ok: true, type: "pdf" });
  });

  it("accepts the bundled sample files", async () => {
    expect(await deckCheck(fixture("sample-deck.pptx"))).toEqual({ ok: true, type: "pptx" });
    expect(await deckCheck(fixture("quarterly-review.pptx"))).toEqual({ ok: true, type: "pptx" });
    expect(await pdfCheck(fixture("sample-handout.pdf"))).toEqual({ ok: true, type: "pdf" });
  });
});

describe("DROP-02 polyglot and wrong type", () => {
  it("refuses a renamed executable", async () => {
    const exe = concat([enc.encode("MZ"), new Uint8Array(600)]);
    expect(await deckCheck(exe)).toEqual({ ok: false, error: "bad_type" });
    expect(await pdfCheck(exe)).toEqual({ ok: false, error: "bad_type" });
  });

  it("refuses an empty and a tiny file", async () => {
    expect(await deckCheck(new Uint8Array())).toEqual({ ok: false, error: "bad_type" });
    expect(await pdfCheck(enc.encode("%PD"))).toEqual({ ok: false, error: "bad_type" });
  });

  it("refuses a deck sent as a PDF and a PDF sent as a deck (extension and detection disagree)", async () => {
    expect(await pdfCheck(validDeck())).toEqual({ ok: false, error: "bad_type" });
    expect(await deckCheck(validPdf())).toEqual({ ok: false, error: "bad_type" });
  });

  it("refuses a zip with no ppt parts", async () => {
    const zip = buildZip([{ name: "word/document.xml", data: "<w/>" }]);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a zip with a content-types part but no presentation part", async () => {
    const zip = buildZip([{ name: "[Content_Types].xml", data: "<Types/>" }]);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a PDF header on a zip: detected as a PDF, so a deck name disagrees", async () => {
    const polyglot = concat([enc.encode("%PDF-1.4\n"), validDeck()]);
    expect(await deckCheck(polyglot)).toEqual({ ok: false, error: "bad_type" });
  });

  it("refuses a PDF that ends in a zip end record", async () => {
    const polyglot = concat([validPdf(), validDeck()]);
    expect(await pdfCheck(polyglot)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a deck with a %PDF marker in its head", async () => {
    const zip = validDeck([{ name: "a.txt", data: "%PDF-1.4" }]);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a PDF with no end marker", async () => {
    expect(await pdfCheck(enc.encode("%PDF-1.4\nno end here"))).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a deck whose end record is missing or whose comment length lies", async () => {
    const zip = validDeck();
    expect(await deckCheck(zip.slice(0, zip.length - 30))).toEqual({ ok: false, error: "bad_structure" });
    const lying = zip.slice();
    lying[lying.length - 2] = 9; // declared comment longer than the file
    expect(await deckCheck(lying)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a deck whose central directory points outside the file", async () => {
    const zip = validDeck();
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    v.setUint32(zip.length - 22 + 16, zip.length + 100, true);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });
});

describe("DROP-02 type: images", () => {
  const jpgCheck = (b: Uint8Array) => validate(reader(b), "jpg");
  const pngCheck = (b: Uint8Array) => validate(reader(b), "png");

  it("accepts a minimal JPEG and PNG", async () => {
    expect(await jpgCheck(validJpeg())).toEqual({ ok: true, type: "jpg" });
    expect(await pngCheck(validPng())).toEqual({ ok: true, type: "png" });
  });

  it("DROP-02 refuses HEIC bytes under any image name: the detected type is none", async () => {
    const heic = concat([new Uint8Array([0, 0, 0, 0x18]), enc.encode("ftypheic"), new Uint8Array(64)]);
    expect(await jpgCheck(heic)).toEqual({ ok: false, error: "bad_type" });
    expect(await pngCheck(heic)).toEqual({ ok: false, error: "bad_type" });
  });

  it("DROP-02 refuses every pair of declared and detected types that differ", async () => {
    const files = { pptx: validDeck(), pdf: validPdf(), jpg: validJpeg(), png: validPng() } as const;
    for (const declared of Object.keys(files) as (keyof typeof files)[]) {
      for (const sent of Object.keys(files) as (keyof typeof files)[]) {
        if (declared === sent) continue;
        expect(await validate(reader(files[sent]), declared)).toEqual({ ok: false, error: "bad_type" });
      }
    }
  });

  it("refuses a bare magic number, an empty file and a truncated JPEG or PNG", async () => {
    expect(await jpgCheck(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({ ok: false, error: "bad_structure" });
    expect(await jpgCheck(new Uint8Array([0xff, 0xd8]))).toEqual({ ok: false, error: "bad_type" });
    expect(await jpgCheck(new Uint8Array())).toEqual({ ok: false, error: "bad_type" });
    const png = validPng();
    expect(await pngCheck(png.slice(0, png.length - 4))).toEqual({ ok: false, error: "bad_structure" });
    expect(await pngCheck(png.slice(0, 8))).toEqual({ ok: false, error: "bad_structure" });
  });
});

describe("DROP-11 image polyglot", () => {
  it("DROP-11 refuses a JPEG or PNG that ends in a zip end record", async () => {
    expect(await validate(reader(concat([validJpeg(), validDeck()])), "jpg")).toEqual({
      ok: false,
      error: "bad_structure",
    });
    expect(await validate(reader(concat([validPng(), validDeck()])), "png")).toEqual({
      ok: false,
      error: "bad_structure",
    });
  });

  it("DROP-11 refuses a PNG with data after IEND", async () => {
    expect(await validate(reader(concat([validPng(), enc.encode("<script>x</script>")])), "png")).toEqual({
      ok: false,
      error: "bad_structure",
    });
  });

  it("DROP-11 a JPEG may carry bytes after its end marker (a Motion Photo clip, a maker trailer), but no PDF or zip", async () => {
    for (const after of ["<html><script>x</script>", "\0", "\xff", "ftypmp42moov"]) {
      expect(await validate(reader(concat([validJpeg(), enc.encode(after)])), "jpg")).toEqual({
        ok: true,
        type: "jpg",
      });
    }
    expect(await validate(reader(concat([validJpeg(), enc.encode("%%EOF\n")])), "jpg")).toEqual({
      ok: false,
      error: "bad_structure",
    });
  });

  it("DROP-11 refuses a JPEG or PNG carrying a PDF: %PDF in the head or %%EOF in the tail", async () => {
    const refused = { ok: false, error: "bad_structure" };
    expect(await validate(reader(validJpeg("%PDF-1.4")), "jpg")).toEqual(refused);
    expect(await validate(reader(concat([validJpeg(), enc.encode("%%EOF\n")])), "jpg")).toEqual(refused);
    const png = validPng();
    const inPng = (s: string) => concat([png.slice(0, -12), enc.encode(s), png.slice(-12)]);
    expect(await validate(reader(inPng("%PDF-1.4")), "png")).toEqual(refused);
    expect(await validate(reader(inPng("%%EOF\n")), "png")).toEqual(refused);
    expect(await validate(reader(inPng("plain")), "png")).toEqual({ ok: true, type: "png" });
  });

  it("DROP-11 keeps HTML inside a JPEG comment: it is accepted, and serving makes it inert (integration)", async () => {
    expect(await validate(reader(validJpeg("<html><script>alert(1)</script>")), "jpg")).toEqual({
      ok: true,
      type: "jpg",
    });
  });
});

describe("VID-01 video type", () => {
  const mp4Check = (b: Uint8Array) => validate(reader(b), "mp4");
  const movCheck = (b: Uint8Array) => validate(reader(b), "mov");
  const ftyp = (brand: string, rest: Uint8Array) =>
    concat([new Uint8Array([0, 0, 0, 16]), enc.encode(`ftyp${brand}`), new Uint8Array(4), rest]);

  it("VID-01 accepts every allowed brand under its own extension", async () => {
    for (const brand of [
      "isom",
      "iso2",
      "iso4",
      "iso5",
      "iso6",
      "mp41",
      "mp42",
      "mp71",
      "avc1",
      "dash",
      "M4V ",
      "M4VP",
      "3gp4",
      "3gp5",
      "XAVC",
    ]) {
      expect(await mp4Check(validVideo(brand))).toEqual({ ok: true, type: "mp4" });
    }
    expect(await movCheck(validVideo("qt  "))).toEqual({ ok: true, type: "mov" });
  });

  it("VID-01 refuses a brand and extension that disagree, and HEIC and unknown brands", async () => {
    expect(await movCheck(validVideo("isom"))).toEqual({ ok: false, error: "bad_type" });
    expect(await mp4Check(validVideo("qt  "))).toEqual({ ok: false, error: "bad_type" });
    for (const brand of ["heic", "mif1", "avif", "3g2a", "XXXX"]) {
      expect(await mp4Check(validVideo(brand))).toEqual({ ok: false, error: "bad_type" });
      expect(await movCheck(validVideo(brand))).toEqual({ ok: false, error: "bad_type" });
    }
  });

  it("VID-01 refuses a video sent under any other type and any other file sent as a video", async () => {
    expect(await validate(reader(validVideo()), "pdf")).toEqual({ ok: false, error: "bad_type" });
    expect(await validate(reader(validVideo()), "jpg")).toEqual({ ok: false, error: "bad_type" });
    expect(await mp4Check(validPdf())).toEqual({ ok: false, error: "bad_type" });
    expect(await mp4Check(validJpeg())).toEqual({ ok: false, error: "bad_type" });
  });

  it("VID-01 accepts an index, fragment or metadata box right after the ftyp box", async () => {
    for (const next of ["moof", "meta", "pdin", "sidx"]) {
      const file = ftyp("iso5", concat([new Uint8Array([0, 0, 0, 16]), enc.encode(next), new Uint8Array(8)]));
      expect(await mp4Check(file), next).toEqual({ ok: true, type: "mp4" });
    }
  });

  it("VID-01 refuses HTML after the ftyp box", async () => {
    const html = ftyp("isom", enc.encode("<html><script>alert(1)</script></html>"));
    expect(await mp4Check(html)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("VID-01 refuses an ftyp box that lies about its size, and a file that is only an ftyp box", async () => {
    const lying = validVideo();
    lying.set([0, 0, 0xff, 0xff], 0);
    expect(await mp4Check(lying)).toEqual({ ok: false, error: "bad_structure" });
    expect(await mp4Check(ftyp("isom", new Uint8Array()))).toEqual({ ok: false, error: "bad_structure" });
    const tiny = validVideo();
    tiny.set([0, 0, 0, 4], 0);
    expect(await mp4Check(tiny)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("VID-01 refuses a PDF marker in the head and a zip end record in the tail", async () => {
    const withPdf = concat([validVideo().slice(0, 36), enc.encode("%PDF-1.4"), new Uint8Array(40)]);
    const pdfAfter = concat([validVideo(), enc.encode("%PDF-1.4\n%%EOF\n")]);
    expect(await mp4Check(withPdf)).toEqual({ ok: false, error: "bad_structure" });
    expect(await mp4Check(pdfAfter)).toEqual({ ok: false, error: "bad_structure" });
    expect(await mp4Check(concat([validVideo(), validDeck()]))).toEqual({ ok: false, error: "bad_structure" });
  });
});

describe("DROP-03 macro", () => {
  it("refuses a vbaProject part, an ActiveX part and any .bin part", async () => {
    for (const name of ["ppt/vbaProject.bin", "ppt/activeX/activeX1.xml", "ppt/embeddings/oleObject1.bin"]) {
      expect(await deckCheck(validDeck([{ name, data: "x" }]))).toEqual({ ok: false, error: "macro_content" });
    }
  });

  it("refuses a macro-enabled content type with no macro part", async () => {
    const types =
      '<Types><Override ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/></Types>';
    expect(await deckCheck(validDeck([], types))).toEqual({ ok: false, error: "macro_content" });
  });
});

describe("DROP-04 bomb", () => {
  it("refuses a declared total over 1 GiB", async () => {
    const zip = validDeck([
      {
        name: "ppt/media/a.xml",
        data: "x",
        method: 8,
        declaredUncompressed: 1024 * 1024 * 1024,
        declaredCompressed: 9e8,
      },
    ]);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses an entry compressed more than 200 to 1", async () => {
    const zip = validDeck([
      {
        name: "ppt/media/b.xml",
        data: "x",
        method: 8,
        declaredUncompressed: 200 * 1024 * 1024,
        declaredCompressed: 1000,
      },
    ]);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a sizeable entry declared with no compressed bytes", async () => {
    const zip = validDeck([
      { name: "ppt/media/c.xml", data: "x", declaredUncompressed: 1_000_000, declaredCompressed: 0 },
    ]);
    expect(await deckCheck(zip)).toEqual({ ok: false, error: "bad_structure" });
  });

  it("allows a small, very repetitive part", async () => {
    const zip = validDeck([{ name: "ppt/slides/s1.xml", data: " ".repeat(30_000), method: 8 }]);
    expect(await deckCheck(zip)).toEqual({ ok: true, type: "pptx" });
  });

  it("refuses more than 5,000 entries", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ name: `ppt/slides/s${i}.xml`, data: "" }));
    expect(await deckCheck(validDeck(many))).toEqual({ ok: false, error: "bad_structure" });
  });

  it("accepts exactly 5,000 entries", async () => {
    const many = Array.from({ length: 4998 }, (_, i) => ({ name: `ppt/slides/s${i}.xml`, data: "" }));
    expect(await deckCheck(validDeck(many))).toEqual({ ok: true, type: "pptx" });
  });

  it("refuses a content-types part that inflates past its cap", async () => {
    const big = `<Types>${" ".repeat(400_000)}</Types>`;
    expect(await deckCheck(validDeck([], big))).toEqual({ ok: false, error: "bad_structure" });
  });

  it("refuses a Zip64 locator, an unknown method and an encrypted entry", async () => {
    const zip = validDeck();
    const locator = concat([
      zip.slice(0, zip.length - 22),
      new Uint8Array([0x50, 0x4b, 0x06, 0x07, ...new Array(16).fill(0)]),
      zip.slice(zip.length - 22),
    ]);
    expect(await deckCheck(locator)).toEqual({ ok: false, error: "bad_structure" });
    const odd = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/presentation.xml", data: "<p/>" },
    ]);
    const v = new DataView(odd.buffer, odd.byteOffset, odd.byteLength);
    const cdOffset = v.getUint32(odd.length - 22 + 16, true);
    v.setUint16(cdOffset + 10, 14, true); // method 14 (LZMA)
    expect(await deckCheck(odd)).toEqual({ ok: false, error: "bad_structure" });
    const enc2 = odd.slice();
    const v2 = new DataView(enc2.buffer);
    v2.setUint16(cdOffset + 10, 0, true);
    v2.setUint16(cdOffset + 8, 1, true); // encrypted flag
    expect(await deckCheck(enc2)).toEqual({ ok: false, error: "bad_structure" });
  });
});
