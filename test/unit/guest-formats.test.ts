import { describe, expect, it, vi } from "vitest";
import {
  checkOoxml,
  checkText,
  decodeXml,
  detect,
  isRelsPart,
  MAX_TEXT_BYTES,
  relationships,
} from "../../src/worker/seams/guest-drop/formats.ts";
import { ReadBudgetExceeded } from "../../src/worker/seams/guest-drop/read-plan.ts";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { type BuiltEntry, reader, validDeck } from "../zip-builder.ts";

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
const BASE = ["[Content_Types].xml", "ppt/presentation.xml"];

/** A package whose relationships parts hold the given texts, the first at the root. */
const pkg = (types: string, ...parts: string[]) => {
  const names = parts.map((_, i) => (i === 0 ? "_rels/.rels" : `ppt/slides/_rels/slide${i}.xml.rels`));
  return checkOoxml([...BASE, ...names], types, new Map(names.map((n, i) => [n, parts[i] as string])));
};

describe("DROP-14 external: relationships", () => {
  it("passes a package whose relationships stay inside", () => {
    expect(pkg(TYPES, rels(internal))).toEqual({ ok: true });
  });

  it("allows an external hyperlink, in either namespace", () => {
    const strict = external("http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink");
    expect(pkg(TYPES, rels(internal, link()), rels(strict))).toEqual({ ok: true });
  });

  it.each(["oleObject", "attachedTemplate", "frame", "image", "audio", "video", "package", "externalLinkPath"])(
    "refuses an external %s relationship in any rels part",
    (kind) => {
      const verdict = pkg(TYPES, rels(internal, link()), rels(external(`${REL}/${kind}`)));
      expect(verdict).toMatchObject({ ok: false });
    },
  );

  it("refuses an external relationship of an unknown or look-alike type", () => {
    for (const type of ["http://x/t", "", "http://evil.example/relationships/hyperlink", `${REL}/hyperlinks`]) {
      expect(pkg(TYPES, rels(external(type)))).toMatchObject({ ok: false, reason: "external relationship" });
    }
  });

  it.each(["TargetMode = 'External'", 'targetmode="external"', 'TargetMode="External"'])(
    "reads the mode written as %s",
    (mode) => {
      expect(relationships(rels(external(`${REL}/oleObject`, mode)))).toEqual([
        { type: `${REL}/oleObject`, target: "https://example.com/a", external: true },
      ]);
    },
  );

  it("is not fooled by the word External elsewhere", () => {
    const named = '<Relationship Id="r" Type="http://x/t" Target="External.xml"/>';
    expect(relationships(rels(named))?.map((r) => r.external)).toEqual([false]);
    expect(relationships(rels(link('TargetMode="Internal"')))?.map((r) => r.external)).toEqual([false]);
  });

  it("reads a tag whose attribute value holds a `>`", () => {
    const tricky = `<Relationship Id="a>" Type="${REL}/oleObject" TargetMode="External" Target="http://x"/>`;
    expect(pkg(TYPES, rels(tricky))).toMatchObject({ ok: false });
  });

  it("reads a namespace-prefixed element", () => {
    const prefixed = `<r:Relationship Type="${REL}/frame" TargetMode="External" Target="http://x"/>`;
    expect(pkg(TYPES, rels(prefixed))).toMatchObject({ ok: false, reason: "external relationship" });
  });

  it("is not fooled by an attribute written inside another attribute's value", () => {
    const shadow = `<Relationship Id=" Type='${REL}/hyperlink'" Type="${REL}/frame" TargetMode="External" Target="x"/>`;
    expect(relationships(rels(shadow))).toEqual([{ type: `${REL}/frame`, target: "x", external: true }]);
    expect(pkg(TYPES, rels(shadow))).toMatchObject({ ok: false, reason: "external relationship" });
  });

  it("refuses a value hidden behind an entity", () => {
    const entity = `<Relationship Type="${REL}/frame" TargetMode="&#69;xternal" Target="http://x"/>`;
    expect(pkg(TYPES, rels(entity))).toMatchObject({ ok: false, reason: "unreadable relationships" });
    const typeEntity = `<Relationship Type="${REL}/h&#121;perlink" TargetMode="External" Target="http://x"/>`;
    expect(pkg(TYPES, rels(typeEntity))).toMatchObject({ ok: false });
  });

  it("refuses XML it cannot read plainly: a DOCTYPE, an unterminated tag or comment, a repeated attribute", () => {
    const doctype = '<!DOCTYPE r [<!ENTITY e "External">]>';
    for (const bad of [
      `${doctype}${rels(internal)}`,
      `<Relationships>${internal.slice(0, -2)}`,
      `<Relationships><!-- ${internal}</Relationships>`,
      '<Relationships><Relationship Type="a" Type="b" Target="c"/></Relationships>',
    ]) {
      expect(pkg(TYPES, bad)).toMatchObject({ ok: false, reason: "unreadable relationships" });
    }
  });

  it("is not hidden by a comment holding an apostrophe", () => {
    const hidden = `<Relationships><!-- it's --><Relationship Type="${REL}/frame" TargetMode="External" Target="x"/><!-- don't --></Relationships>`;
    expect(pkg(TYPES, hidden)).toMatchObject({ ok: false, reason: "external relationship" });
  });

  it("refuses a macro or control relationship that stays inside the package", () => {
    for (const type of [
      `${REL}/oleObject`,
      "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
      "http://schemas.microsoft.com/office/2006/relationships/activeXControlBinary",
      `${REL}/control`,
    ]) {
      const inside = `<Relationship Id="r" Type="${type}" Target="embeddings/x.bin"/>`;
      expect(pkg(TYPES, rels(inside))).toMatchObject({ ok: false, reason: "macro relationship" });
    }
  });

  it("refuses a package with a relationships part nobody supplied", () => {
    const names = [...BASE, "_rels/.rels", "ppt/slides/_rels/slide1.xml.rels"];
    const verdict = checkOoxml(names, TYPES, new Map([["_rels/.rels", rels(internal)]]));
    expect(verdict).toMatchObject({ ok: false, reason: "unreadable relationships" });
  });

  it("names a relationships part in any folder, whatever its case", () => {
    expect(["_rels/.rels", "ppt/_rels/presentation.xml.rels", "A/_RELS/B.RELS"].every(isRelsPart)).toBe(true);
    expect(["ppt/rels.xml", "x_rels/y.rels", "_rels/y.rels/z"].some(isRelsPart)).toBe(false);
  });

  it("decodes UTF-8 and refuses UTF-16 and another declared encoding", () => {
    expect(decodeXml(enc.encode(rels(internal)))).toBe(rels(internal));
    expect(decodeXml(bytes([0xef, 0xbb, 0xbf], rels(internal)))).toContain("Relationships");
    expect(decodeXml(Uint8Array.from([0xff, 0xfe, 0x3c, 0x00]))).toBeNull();
    expect(decodeXml(Uint8Array.from([0xfe, 0xff, 0x00, 0x3c]))).toBeNull();
    expect(decodeXml(enc.encode('<?xml version="1.0" encoding="UTF-16"?><a/>'))).toBeNull();
    expect(decodeXml(enc.encode('<?xml version="1.0" encoding="utf-8"?><a/>'))).not.toBeNull();
    expect(decodeXml(Uint8Array.from([0x3c, 0xff, 0x3e]))).toBeNull();
  });

  it("scans a large part in linear time", () => {
    const hostile = "<Relationship ".repeat(18_000);
    const t = performance.now();
    expect(relationships(hostile)).toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("DROP-14 external: entry names", () => {
  it.each(["word\\_rels\\document.xml.rels", "word/_rels/a%2Fb.rels", "ppt\\slides\\slide1.xml", "a%5Cb"])(
    "refuses the name %j, which an extractor may read as a path",
    (name) => {
      expect(checkOoxml([...BASE, name], TYPES, new Map())).toMatchObject({ ok: false, reason: "entry name" });
    },
  );

  it.each([
    ["docx", "word/document.xml", "WORD/Document.xml"],
    ["xlsx", "xl/workbook.xml", "xl/WORKBOOK.xml"],
    ["pptx", "ppt/presentation.xml", "ppt/presentation.xml"],
  ])("refuses two %s parts of one name, without regard to case", (_, one, two) => {
    const names = ["[Content_Types].xml", one, two];
    expect(checkOoxml(names, TYPES, new Map())).toMatchObject({ ok: false, reason: "duplicate name" });
    expect(checkOoxml(names.slice(0, 2), TYPES, new Map())).toEqual({ ok: true });
  });
});

describe("DROP-14 external: macro-enabled packages", () => {
  const word = (ct: string) => `<Types><Override PartName="/word/document.xml" ContentType="${ct}"/></Types>`;
  const none = new Map<string, string>();
  const WORD_NAMES = ["[Content_Types].xml", "word/document.xml"];

  it.each([
    "application/vnd.ms-word.document.macroEnabled.main+xml",
    "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  ])("refuses the content type %s whatever the extension", (ct) => {
    expect(checkOoxml(WORD_NAMES, word(ct), none)).toMatchObject({ ok: false, error: "macro_content" });
  });

  it("refuses a content type written with an entity", () => {
    const hidden = word("application/vnd.ms-word.document.macro&#69;nabled.main+xml");
    expect(checkOoxml(WORD_NAMES, hidden, none)).toMatchObject({ ok: false, reason: "content types" });
    expect(checkOoxml(WORD_NAMES, "<Types><Override", none)).toMatchObject({ ok: false, reason: "content types" });
  });

  it("refuses a VBA project or ActiveX part under any folder", () => {
    for (const name of ["word/vbaProject.bin", "xl/vbaProject.bin", "ppt/activeX/activeX1.xml", "VBAPROJECT.BIN"]) {
      expect(checkOoxml([...BASE, name], TYPES, none)).toMatchObject({ ok: false, reason: "macro part" });
    }
  });

  it("passes the printer settings Excel and Word write into ordinary files, and nothing else binary", () => {
    const xlsx = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"];
    const rels = new Map([
      [
        "_rels/.rels",
        '<Relationships><Relationship Id="a" Type="http://x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ],
      [
        "xl/_rels/workbook.xml.rels",
        '<Relationships><Relationship Id="b" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ],
    ]);
    for (const ok of ["xl/printerSettings/printerSettings1.bin", "word/printerSettings/printerSettings12.bin"]) {
      expect(checkOoxml([...xlsx, ok], TYPES, rels)).toEqual({ ok: true });
    }
    for (const bad of [
      "xl/embeddings/oleObject1.bin",
      "word/embeddings/oleObject1.bin",
      "xl/printerSettings/other.bin",
      "xl/x/printerSettings/y/printerSettings1.bin",
      "xl/printerSettings/printerSettings.bin",
    ]) {
      expect(checkOoxml([...xlsx, bad], TYPES, rels)).toMatchObject({ ok: false, reason: "macro part" });
    }
  });

  it("applies the same rule to a deck, through the validator", async () => {
    const ok = await validate(reader(validDeck([{ name: "ppt/printerSettings/printerSettings1.bin" }])), "pptx");
    expect(ok).toEqual({ ok: true, type: "pptx" });
    const bad = await validate(reader(validDeck([{ name: "ppt/embeddings/oleObject1.bin" }])), "pptx");
    expect(bad).toEqual({ ok: false, error: "macro_content" });
  });

  describe("a deck's relationships, through the validator", () => {
    const deck = (relsXml: string, name = "ppt/_rels/presentation.xml.rels", method: 0 | 8 = 8) =>
      validate(reader(validDeck([{ name, data: relsXml, method }])), "pptx");

    it("passes internal relationships and an external hyperlink", async () => {
      const verdict = await deck(rels(internal, link()));
      expect(verdict).toEqual({ ok: true, type: "pptx" });
    });

    it("refuses an oleObject or vbaProject relationship, inside the package or out", async () => {
      for (const type of [`${REL}/oleObject`, "http://schemas.microsoft.com/office/2006/relationships/vbaProject"]) {
        const inside = `<Relationship Id="r" Type="${type}" Target="embeddings/x.bin"/>`;
        expect(await deck(rels(inside))).toEqual({ ok: false, error: "macro_content" });
        expect(await deck(rels(external(type)))).toEqual({ ok: false, error: "macro_content" });
      }
    });

    it("refuses an external relationship that is not a hyperlink", async () => {
      expect(await deck(rels(external(`${REL}/frame`)))).toEqual({ ok: false, error: "bad_structure" });
    });

    it("refuses a relationships part it cannot read as UTF-8 XML", async () => {
      expect(await deck("<Relationships><Relationship", "ppt/_rels/presentation.xml.rels")).toEqual({
        ok: false,
        error: "bad_structure",
      });
      const utf16 = Uint8Array.from([0xff, 0xfe, ...[...rels(internal)].flatMap((c) => [c.charCodeAt(0), 0])]);
      const entry = { name: "ppt/_rels/presentation.xml.rels", data: utf16, method: 8 as const };
      expect(await validate(reader(validDeck([entry])), "pptx")).toEqual({ ok: false, error: "bad_structure" });
    });

    const relsEntry = (name: string, data: string, declared?: number): BuiltEntry => ({
      name,
      data,
      method: 8,
      ...(declared === undefined ? {} : { declaredUncompressed: declared }),
    });

    it("measures the relationships it inflates, not the size the archive declares", async () => {
      const padded = `<Relationships/>${" ".repeat(256 * 1024 - 16)}`;
      const lying = Array.from({ length: 100 }, (_, i) => relsEntry(`x/_rels/a${i}.rels`, padded, 0));
      expect(await validate(reader(validDeck(lying)), "pptx")).toEqual({ ok: false, error: "bad_structure" });
    });

    describe("the read plan: every metered read is one R2 operation and one D1 meter write", () => {
      const counted = (data: Uint8Array) => {
        const inner = reader(data);
        const seen = { reads: 0 };
        return {
          seen,
          size: inner.size,
          read: (at: number, n: number) => {
            seen.reads++;
            return inner.read(at, n);
          },
        };
      };
      const parts = (count: number, bytes: number, declared?: number) =>
        Array.from({ length: count }, (_, i) =>
          relsEntry(`x/_rels/a${i}.rels`, `<Relationships/>${" ".repeat(bytes - 16)}`, declared),
        );
      const MIB = 1024 * 1024;

      it("reads a small deck in two operations, the head and the whole object, however many parts it has", async () => {
        for (const count of [1, 300, 1024]) {
          const small = counted(validDeck(parts(count, 16)));
          expect(await validate(small, "pptx")).toEqual({ ok: true, type: "pptx" });
          expect(small.seen.reads).toBe(2);
        }
      });

      it("refuses, in two operations, a small deck with over 1024 parts or whose parts inflate past the budget", async () => {
        const many = counted(validDeck(parts(1500, 100 * 1024, 0)));
        expect(await validate(many, "pptx")).toEqual({ ok: false, error: "bad_structure" });
        expect(many.seen.reads).toBe(2);
        const heavy = counted(validDeck(parts(300, 250 * 1024, 0)));
        expect(await validate(heavy, "pptx")).toEqual({ ok: false, error: "bad_structure" });
        expect(heavy.seen.reads).toBe(2);
      });

      const media = (mib: number): BuiltEntry => ({ name: "ppt/media/big.png", data: new Uint8Array(mib * MIB) });

      it("reads a large deck's parts in one range per cluster", async () => {
        const together = counted(validDeck([...parts(300, 16), media(17)]));
        expect(await validate(together, "pptx")).toEqual({ ok: true, type: "pptx" });
        // head, end record, directory, then the content types and every relationships part in one read
        expect(together.seen.reads).toBe(4);
        const apart = counted(
          validDeck([...parts(150, 16), media(17), ...parts(150, 16).map((e) => ({ ...e, name: `y${e.name}` }))]),
        );
        expect(await validate(apart, "pptx")).toEqual({ ok: true, type: "pptx" });
        expect(apart.seen.reads).toBe(5);
      });
    });

    it("refuses a deck with more than 1024 relationships parts", async () => {
      const part = (i: number) => relsEntry(`x/_rels/a${i}.rels`, "<Relationships/>", 0);
      const ok = Array.from({ length: 1024 }, (_, i) => part(i));
      expect(await validate(reader(validDeck(ok)), "pptx")).toEqual({ ok: true, type: "pptx" });
      expect(await validate(reader(validDeck([...ok, part(1024)])), "pptx")).toEqual({
        ok: false,
        error: "bad_structure",
      });
    });

    it("answers macro_content for a macro deck even when its relationships cannot be read", async () => {
      const utf16 = { name: "ppt/_rels/p.xml.rels", data: Uint8Array.from([0xff, 0xfe, 0x3c, 0]), method: 8 as const };
      const entries = [relsEntry("ppt/vbaProject.bin", "x"), utf16];
      expect(await validate(reader(validDeck(entries)), "pptx")).toEqual({ ok: false, error: "macro_content" });
    });

    it("refuses two parts of one name, whose reader would pick either", async () => {
      const clean = relsEntry("_rels/.rels", rels(internal));
      const evil = relsEntry("_rels/.rels", rels(`<Relationship Type="${REL}/oleObject" Target="x"/>`));
      expect(await validate(reader(validDeck([clean, evil])), "pptx")).toEqual({ ok: false, error: "bad_structure" });
      expect(await validate(reader(validDeck([clean, { ...clean, name: "_RELS/.RELS" }])), "pptx")).toEqual({
        ok: false,
        error: "bad_structure",
      });
    });

    describe("a local header that disagrees with the central directory", () => {
      const NAME = "x/_rels/a.rels";
      const crafted = (edit: (zip: Uint8Array, local: number) => void) => {
        const zip = validDeck([relsEntry(NAME, rels(internal))]);
        const local = Buffer.from(zip).indexOf(NAME) - 30;
        edit(zip, local);
        return zip;
      };

      it("passes when they agree", async () => {
        expect(await validate(reader(crafted(() => {})), "pptx")).toEqual({ ok: true, type: "pptx" });
      });

      it("refuses a different compression method", async () => {
        const zip = crafted((z, at) => new DataView(z.buffer).setUint16(at + 8, 0, true));
        expect(await validate(reader(zip), "pptx")).toEqual({ ok: false, error: "bad_structure" });
      });

      it("refuses a different name of the same length", async () => {
        const zip = crafted((z, at) => z.set(enc.encode("b"), at + 30 + NAME.indexOf("a.")));
        expect(await validate(reader(zip), "pptx")).toEqual({ ok: false, error: "bad_structure" });
      });
    });

    it("logs a read budget refusal as drop.refused with reason read_budget, and answers bad_structure", async () => {
      const deck = reader(validDeck([relsEntry("x/_rels/a.rels", rels(internal))]));
      let reads = 0;
      const spent = {
        size: deck.size,
        read: (at: number, n: number) => {
          if (++reads > 1) throw new ReadBudgetExceeded();
          return deck.read(at, n);
        },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await validate(spent, "pptx")).toEqual({ ok: false, error: "bad_structure" });
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { evt: "drop.refused", reason: "read_budget", bytes: deck.size },
      ]);
      warn.mockRestore();
    });

    it("refuses a part name that hides a relationships part behind a backslash or a percent sign", async () => {
      expect(await deck(rels(`<Relationship Type="${REL}/oleObject" Target="x"/>`), "ppt\\_rels\\p.xml.rels")).toEqual({
        ok: false,
        error: "bad_structure",
      });
      expect(await deck(rels(internal), "ppt/slides/a%2Fb.xml")).toEqual({ ok: false, error: "bad_structure" });
    });
  });

  it("passes the macro-free types", () => {
    const plain = word("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
    expect(checkOoxml(WORD_NAMES, plain, none)).toEqual({ ok: true });
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
    expect(detect(webp)).toBe("webp");
    expect(detect(gif)).toBe("gif");
    expect(detect(bytes("GIF87a", [1, 0, 1, 0]))).toBe("gif");
    expect(detect(heic)).toBe("heic");
    expect(detect(webm)).toBe("webm");
  });

  it("accepts the other HEIF major brands", () => {
    for (const brand of ["heix", "hevc", "mif1", "msf1"]) {
      expect(detect(bytes([0, 0, 0, 24], `ftyp${brand}`, [0, 0, 0, 0]))).toBe("heic");
    }
  });

  it("names each format by its own bytes, never by another's", () => {
    expect(detect(gif)).not.toBe("webp");
    expect(detect(webp)).not.toBe("gif");
    expect(detect(webm)).not.toBe("heic");
  });

  it("refuses a RIFF file that is not WebP", () => {
    expect(detect(bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "))).toBeNull();
  });

  it("refuses Matroska, which shares the WebM header; an MP4 brand is an MP4", () => {
    const mkv = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x88], "matroska");
    expect(detect(mkv)).toBeNull();
    expect(detect(bytes([0, 0, 0, 24], "ftypisom", [0, 0, 0, 0], "isomiso2"))).toBe("mp4");
  });

  it("refuses short and empty input", () => {
    for (const head of [
      new Uint8Array(),
      bytes("RIFF"),
      bytes("GIF8"),
      bytes([0, 0, 0, 24], "ftyp"),
      bytes([0x1a, 0x45]),
    ]) {
      expect(detect(head)).toBeNull();
    }
  });

  it("ignores a WebM doctype beyond the EBML header", () => {
    const late = bytes([0x1a, 0x45, 0xdf, 0xa3], new Array(80).fill(0), [0x42, 0x82, 0x84], "webm");
    expect(detect(late)).toBeNull();
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
      error: "bad_structure",
      reason: "not UTF-8",
    });
    expect(checkText(Uint8Array.from([0xc3, 0x28]))).toMatchObject({ ok: false });
    expect(checkText(Uint8Array.from([0xed, 0xa0, 0x80]))).toMatchObject({ ok: false });
  });

  it("refuses a NUL byte", () => {
    expect(checkText(bytes("a", [0], "b"))).toMatchObject({ ok: false, error: "bad_structure", reason: "NUL in text" });
  });

  it("allows exactly 5 MB and refuses one byte more", () => {
    expect(checkText(new Uint8Array(MAX_TEXT_BYTES).fill(0x61))).toEqual({ ok: true });
    expect(checkText(new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x61))).toMatchObject({ ok: false, error: "too_large" });
  });
});
