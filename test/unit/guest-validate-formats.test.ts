import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FORMATS, type FormatType } from "../../src/worker/seams/guest-drop/formats.ts";
import { MAX_PIXELS } from "../../src/worker/seams/guest-drop/image.ts";
import { PDF_WINDOW_BYTES, scanPdf, scanPdfChunks } from "../../src/worker/seams/guest-drop/pdf-scan.ts";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { buildCfb } from "../cfb-builder.ts";
import {
  buildZip,
  concat,
  reader,
  validDeck,
  validGif,
  validHeic,
  validJpeg,
  validPackage,
  validPdf,
  validPng,
  validVideo,
  validWebm,
  validWebp,
} from "../zip-builder.ts";

const enc = new TextEncoder();
const refused = (error: string) => ({ ok: false, error });
const check = (bytes: Uint8Array, declared: FormatType) => validate(reader(bytes), declared);

describe("DROP-12 cfb: legacy Office files through validate", () => {
  const WORD = ["WordDocument", "1Table"];
  const sheet = ["Workbook", "\x05SummaryInformation"];
  const deck = ["PowerPoint Document", "Current User"];

  it("accepts each kind under its own name", async () => {
    expect(await check(buildCfb(WORD), "doc")).toEqual({ ok: true, type: "doc" });
    expect(await check(buildCfb(sheet), "xls")).toEqual({ ok: true, type: "xls" });
    expect(await check(buildCfb(["Book"]), "xls")).toEqual({ ok: true, type: "xls" });
    expect(await check(buildCfb(deck), "ppt")).toEqual({ ok: true, type: "ppt" });
  });

  it("refuses a compound file of another kind, and a macro or password protected one", async () => {
    expect(await check(buildCfb(WORD), "xls")).toEqual(refused("bad_structure"));
    expect(await check(buildCfb([...WORD, "Macros", "VBA"]), "doc")).toEqual(refused("macro_content"));
    expect(await check(buildCfb(["EncryptionInfo", "EncryptedPackage"]), "doc")).toEqual(refused("encrypted"));
  });

  it("refuses a compound file declared as a zip type and the reverse", async () => {
    expect(await check(buildCfb(WORD), "docx")).toEqual(refused("bad_type"));
    expect(await check(validDeck(), "ppt")).toEqual(refused("bad_type"));
  });
});

describe("DROP-14 external: every package kind goes through the same checks", () => {
  const PARTS = { pptx: "ppt/presentation.xml", docx: "word/document.xml", xlsx: "xl/workbook.xml" } as const;
  const rels = (target: string, mode = "") =>
    `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="${target}"${mode}/></Relationships>`;

  it.each(Object.entries(PARTS))("accepts a clean %s and refuses another kind's part", async (kind, part) => {
    expect(await check(validPackage(part), kind as FormatType)).toEqual({ ok: true, type: kind });
    const other = Object.values(PARTS).find((p) => p !== part) as string;
    expect(await check(validPackage(other), kind as FormatType)).toEqual(refused("bad_structure"));
  });

  it.each(Object.entries(PARTS))("refuses %s with an external relationship or a macro part", async (kind, part) => {
    const external = validPackage(part, [
      { name: "_rels/.rels", data: rels("http://evil.example/x", ' TargetMode="External"') },
    ]);
    expect(await check(external, kind as FormatType)).toEqual(refused("macro_content"));
    const hyper = `<Relationships><Relationship Id="r1" Type="http://evil/other" Target="http://evil.example/" TargetMode="External"/></Relationships>`;
    expect(await check(validPackage(part, [{ name: "_rels/.rels", data: hyper }]), kind as FormatType)).toEqual(
      refused("bad_structure"),
    );
    expect(await check(validPackage(part, [{ name: "word/vbaProject.bin", data: "x" }]), kind as FormatType)).toEqual(
      refused("macro_content"),
    );
  });

  it("refuses a docx that carries a macro-enabled content type (a renamed docm)", async () => {
    const types =
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>';
    expect(await check(validPackage("word/document.xml", [], types), "docx")).toEqual(refused("macro_content"));
  });
});

describe("DROP-15 magic: each format by its own bytes", () => {
  const cases: [FormatType, Uint8Array][] = [
    ["jpg", validJpeg()],
    ["png", validPng()],
    ["gif", validGif()],
    ["webp", validWebp()],
    ["heic", validHeic()],
    ["mp4", validVideo("isom")],
    ["mov", validVideo("qt  ")],
    ["webm", validWebm()],
    ["pdf", validPdf()],
    ["pptx", validDeck()],
  ];

  it.each(cases)("accepts a clean %s", async (type, bytes) => {
    expect(await check(bytes, type)).toEqual({ ok: true, type });
  });

  it("refuses each file under every other type's name (a detected type that differs is bad_type)", async () => {
    for (const [declared] of cases) {
      for (const [sent, bytes] of cases) {
        if (declared === sent || (declared === "mp4" && sent === "mov") || (declared === "mov" && sent === "mp4"))
          continue;
        expect(await check(bytes, declared), `${sent} as ${declared}`).toEqual(refused("bad_type"));
      }
    }
  });

  it("knows every type in FORMATS", () => {
    expect(Object.keys(FORMATS).sort()).toEqual(
      "csv doc docx gif heic jpg md mov mp4 pdf png ppt pptx txt webm webp xls xlsx".split(" "),
    );
  });

  it("refuses a gif without its trailer, a webp whose RIFF length lies, a heic without a meta box", async () => {
    const gif = validGif();
    expect(await check(gif.slice(0, -1), "gif")).toEqual(refused("bad_structure"));
    const webp = validWebp();
    expect(await check(concat([webp, new Uint8Array(4)]), "webp")).toEqual(refused("bad_structure"));
    const heic = validHeic();
    heic.set(enc.encode("junk"), 20);
    expect(await check(heic, "heic")).toEqual(refused("bad_structure"));
  });

  it("refuses a PDF or a zip riding on a gif, webp, heic or webm", async () => {
    for (const [type, bytes] of [
      ["gif", validGif()],
      ["webp", validWebp()],
      ["heic", validHeic()],
      ["webm", validWebm()],
    ] as const) {
      expect(await check(concat([bytes, validDeck()]), type), type).toEqual(refused("bad_structure"));
      expect(await check(concat([bytes, enc.encode("%%EOF\n")]), type), type).toEqual(refused("bad_structure"));
    }
  });

  it.each(["txt", "md", "csv"] as const)("accepts %s text and refuses what is not text", async (type) => {
    expect(await check(enc.encode("a,b\n1,2\n"), type)).toEqual({ ok: true, type });
    expect(await check(new Uint8Array([0x61, 0xff, 0xfe]), type)).toEqual(refused("bad_structure"));
    expect(await check(new Uint8Array([0x61, 0, 0x62]), type)).toEqual(refused("bad_structure"));
  });

  it("refuses text over 5 MB without reading it", async () => {
    const big = { size: 5 * 1024 * 1024 + 1, read: async () => Promise.reject(new Error("read")) };
    expect(await validate(big, "txt")).toEqual(refused("too_large"));
  });
});

describe("DROP-16 pixels: the cap by each format's own header", () => {
  const over = Math.floor(Math.sqrt(MAX_PIXELS)) + 1;

  it.each([
    ["jpg", (w: number, h: number) => validJpeg("x", w, h)],
    ["png", validPng],
    ["gif", validGif],
    ["webp", validWebp],
  ] as const)("DROP-16 pixels: %s over 100 MP is too_large, a 48 MP frame passes", async (type, build) => {
    expect(await check(build(over, over), type)).toEqual(refused("too_large"));
    expect(await check(build(8000, 6000), type)).toEqual({ ok: true, type });
  });

  it("png: 48 MP passes and 30,000 x 30,000 is refused", async () => {
    expect(await check(validPng(8000, 6000), "png")).toEqual({ ok: true, type: "png" });
    expect(await check(validPng(30000, 30000), "png")).toEqual(refused("too_large"));
  });

  it("refuses a zero size and a header that is not where the format puts it", async () => {
    expect(await check(validPng(0, 5), "png")).toEqual(refused("bad_structure"));
    expect(await check(validGif(0, 0), "gif")).toEqual(refused("bad_structure"));
    const jpg = validJpeg();
    jpg[3] = 0xe1; // the comment becomes APP1; the frame header still follows
    expect(await check(jpg, "jpg")).toEqual({ ok: true, type: "jpg" });
    expect(await check(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "jpg")).toEqual(refused("bad_structure"));
  });

  it("reads the lossy and extended WebP headers", async () => {
    const lossy = concat([
      enc.encode("VP8 "),
      new Uint8Array([10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x11, 0x27, 0x11, 0x27]), // 10001 x 10001
    ]);
    const riff = (chunk: Uint8Array) =>
      concat([enc.encode("RIFF"), new Uint8Array([chunk.length + 4, 0, 0, 0]), enc.encode("WEBP"), chunk]);
    expect(await check(riff(lossy), "webp")).toEqual(refused("too_large"));
    const extended = concat([enc.encode("VP8X"), new Uint8Array([10, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0, 0, 0x0f, 0, 0])]);
    expect(await check(riff(extended), "webp")).toEqual({ ok: true, type: "webp" });
  });
});

describe("DROP-13 pdf-active: through validate", () => {
  const withBody = (body: string) => enc.encode(`%PDF-1.5\n${body}\n%%EOF\n`);

  it("accepts a clean PDF and refuses active content, encryption and an unreadable object stream", async () => {
    expect(await check(validPdf(), "pdf")).toEqual({ ok: true, type: "pdf" });
    expect(await check(withBody("<< /OpenAction 1 0 R >>"), "pdf")).toEqual(refused("macro_content"));
    expect(await check(withBody("<< /J#61vaScript 1 0 R >>"), "pdf")).toEqual(refused("macro_content"));
    expect(await check(withBody("trailer << /Encrypt 9 0 R >>"), "pdf")).toEqual(refused("encrypted"));
    expect(
      await check(withBody("5 0 obj\n<< /Type /ObjStm /Filter /LZWDecode >>\nstream\nxx\nendstream"), "pdf"),
    ).toEqual(refused("bad_structure"));
  });
});

describe("DROP-13 pdf-active: the chunked scan reads what the whole scan reads", () => {
  const objStm = (inner: string) => {
    const data = deflateSync(enc.encode(inner));
    return concat([
      enc.encode(`5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
      data,
      enc.encode("\nendstream\nendobj\n"),
    ]);
  };
  const chunked = (bytes: Uint8Array, size: number) => {
    let at = 0;
    return scanPdfChunks(async () => {
      if (at >= bytes.length) return null;
      const chunk = bytes.slice(at, at + size);
      at += size;
      return chunk;
    });
  };
  const filler = (n: number) =>
    enc.encode(`${"0 0 obj << /Filler (padding padding) >> endobj\n".repeat(Math.ceil(n / 44))}`).slice(0, n);

  const corpus: [string, Uint8Array][] = [
    ["clean", concat([enc.encode("%PDF-1.5\n"), filler(20_000), enc.encode("%%EOF\n")])],
    [
      "a name in the open",
      concat([enc.encode("%PDF-1.5\n"), filler(20_000), enc.encode("<< /JavaScript 1 0 R >>\n%%EOF\n")]),
    ],
    [
      "an escaped name",
      concat([
        enc.encode("%PDF-1.5\n"),
        filler(9_000),
        enc.encode("<< /#4Aava#53cript 1 0 R /Launch 2 0 R >>\n%%EOF\n"),
      ]),
    ],
    [
      "a long look-alike token",
      concat([enc.encode("%PDF-1.5\n/JavaScript"), enc.encode("x".repeat(30_000)), enc.encode("\n%%EOF\n")]),
    ],
    [
      "a hidden object stream",
      concat([enc.encode("%PDF-1.5\n"), filler(15_000), objStm("<< /S /JavaScript >>"), enc.encode("%%EOF\n")]),
    ],
    [
      "a clean object stream",
      concat([enc.encode("%PDF-1.5\n"), filler(15_000), objStm("<< /Type /Catalog >>"), enc.encode("%%EOF\n")]),
    ],
    [
      "an unreadable object stream",
      concat([
        enc.encode(
          "%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\nnot deflate\nendstream\n%%EOF\n",
        ),
      ]),
    ],
    [
      "encrypted",
      concat([enc.encode("%PDF-1.5\n"), filler(12_000), enc.encode("trailer << /Encrypt 9 0 R >>\n%%EOF\n")]),
    ],
  ];

  it.each(corpus)("agrees with scanPdf on %s at every window size", async (_, bytes) => {
    const whole = await scanPdf(bytes);
    for (const size of [1, 7, 100, 1000, 4096, 8191, 8193, 9000, 20_011, bytes.length + 5]) {
      expect(await chunked(bytes, size), `window ${size}`).toEqual(whole);
    }
  });

  it("finds a refused name split across a window boundary at every offset", async () => {
    const body = concat([enc.encode("%PDF-1.5\n"), filler(20_000), enc.encode("<< /JavaScript 1 0 R >>\n%%EOF\n")]);
    const at = body.length - 30;
    for (let size = at - 20; size < at + 20; size++) {
      expect(await chunked(body, size), `window ${size}`).toMatchObject({ ok: false, found: ["JavaScript"] });
    }
  });

  it("DROP-13 pdf-active: refuses a name at byte 300 MiB of a 450 MB PDF read in 8 MiB windows", async () => {
    const total = 450 * 1000 * 1000;
    const hit = 300 * 1024 * 1024;
    const pad = new Uint8Array(PDF_WINDOW_BYTES).fill(0x20);
    let at = 0;
    const result = await scanPdfChunks(async () => {
      if (at >= total) return null;
      const n = Math.min(PDF_WINDOW_BYTES, total - at);
      const chunk = n === PDF_WINDOW_BYTES ? pad.slice() : pad.slice(0, n);
      if (hit >= at && hit < at + n) chunk.set(enc.encode("/Launch"), hit - at);
      at += n;
      return chunk;
    });
    expect(result).toMatchObject({ ok: false, found: ["Launch"] });
  }, 120_000);
});

describe("DROP-02 type: zip kinds do not cross-read", () => {
  it("refuses a zip with no parts for any package kind", async () => {
    for (const kind of ["pptx", "docx", "xlsx"] as const) {
      expect(await check(buildZip([{ name: "a.txt", data: "x" }]), kind)).toEqual(refused("bad_structure"));
    }
  });
});
