import { readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type SourceContext, typeOfName } from "../../src/worker/seams/file-source/index.ts";
import { MockFileSource, type MockFixture } from "../../src/worker/seams/file-source/mock.ts";

const decks = new URL("../fixtures/decks/", import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, decks)));
const NOW = 1_800_000_000_000;

const fixtures: MockFixture[] = [
  { id: "deck", name: "A.pptx", type: "pptx", bytes: new Uint8Array([1, 2, 3]), editedMinutesAgo: 10, pdfId: "pdf" },
  { id: "old", name: "B.pptx", type: "pptx", bytes: new Uint8Array([4]), editedMinutesAgo: 500, pdfId: null },
  { id: "pdf", name: "C.pdf", type: "pdf", bytes: new Uint8Array([5, 6]), editedMinutesAgo: 60, pdfId: null },
];
const source = new MockFileSource(fixtures, () => NOW);
const ctx: SourceContext = {
  mode: "demo",
  userId: null,
  folderId: null,
  accessToken: async () => ({ ok: false, error: "auth_required" }),
};

describe("MockFileSource", () => {
  it("lists newest edit first, relative to now, in the FileEntry shape", async () => {
    const res = await source.listRecent(ctx, 5);
    expect(res).toEqual({
      ok: true,
      files: [
        { id: "deck", name: "A.pptx", type: "pptx", modifiedAt: NOW - 600_000, size: 3 },
        { id: "pdf", name: "C.pdf", type: "pdf", modifiedAt: NOW - 3_600_000, size: 2 },
        { id: "old", name: "B.pptx", type: "pptx", modifiedAt: NOW - 30_000_000, size: 1 },
      ],
    });
    expect((await source.listRecent(ctx, 2)).ok && (await source.listRecent(ctx, 2))).toMatchObject({
      files: [{ id: "deck" }, { id: "pdf" }],
    });
  });

  it("resolves a listed id to its name, type, size and a stream of its bytes, with no external URL", async () => {
    const res = await source.resolve(ctx, "pdf");
    if (!res.ok) throw new Error("resolve failed");
    expect(res.file).toMatchObject({ name: "C.pdf", type: "pdf", size: 2, url: null });
    const body = await res.file.body();
    expect(body.ok && body.length).toBe(2);
    expect(body.ok && Array.from(new Uint8Array(await new Response(body.stream).arrayBuffer()))).toEqual([5, 6]);
  });

  it("SRC-02 file: an unknown id, including inherited object keys, is file_not_found", async () => {
    for (const id of ["nope", "", "__proto__", "constructor", "toString", "../deck"]) {
      expect(await source.resolve(ctx, id), id).toEqual({ ok: false, error: "file_not_found" });
      expect(await source.resolvePdf(ctx, id), id).toEqual({ ok: false, error: "file_not_found" });
    }
  });

  it("serves a PDF rendition: the named fixture for a deck, itself for a PDF, pdf_unavailable for a deck with none", async () => {
    const viaDeck = await source.resolvePdf(ctx, "deck");
    expect(viaDeck.ok && viaDeck.file.name).toBe("C.pdf");
    const viaPdf = await source.resolvePdf(ctx, "pdf");
    expect(viaPdf.ok && viaPdf.file.name).toBe("C.pdf");
    expect(await source.resolvePdf(ctx, "old")).toEqual({ ok: false, error: "pdf_unavailable" });
  });

  it("each body() call gives a fresh stream", async () => {
    const res = await source.resolve(ctx, "deck");
    if (!res.ok) throw new Error("resolve failed");
    for (let i = 0; i < 2; i++) {
      const body = await res.file.body();
      expect(body.ok && (await new Response(body.stream).arrayBuffer()).byteLength).toBe(3);
    }
  });
});

describe("typeOfName", () => {
  it("accepts .pptx and .pdf in any case and refuses everything else, macro decks included", () => {
    expect(typeOfName("A.pptx")).toBe("pptx");
    expect(typeOfName("A.PPTX")).toBe("pptx");
    expect(typeOfName("a.b.Pdf")).toBe("pdf");
    for (const name of ["a.pptm", "a.ppt", "a.ppsx", "a.potx", "a.docx", "pptx", "a.pptx.exe", ""]) {
      expect(typeOfName(name), name).toBeNull();
    }
  });
});

/** Reads a zip's central directory and inflates every entry, so a bad offset or CRC fails here. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const [method, packedSize, size, nameLength, extra, comment, local] = [
      view.getUint16(at + 10, true),
      view.getUint32(at + 20, true),
      view.getUint32(at + 24, true),
      view.getUint16(at + 28, true),
      view.getUint16(at + 30, true),
      view.getUint16(at + 32, true),
      view.getUint32(at + 42, true),
    ];
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = bytes.subarray(dataStart, dataStart + packedSize);
    if (!/\.(xml|rels)$/.test(name)) {
      // Media: checked for size only, never decoded as text; listed with empty text so targets resolve.
      expect([0, 8]).toContain(method);
      expect((method === 0 ? packed : inflateRawSync(packed)).byteLength).toBe(size);
      out.set(name, "");
      at += 46 + nameLength + extra + comment;
      continue;
    }
    expect(method).toBe(8);
    const text = inflateRawSync(packed).toString("utf8");
    expect(text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(text)).toBe(size);
    out.set(name, text);
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/** Relationship targets exist, slides have content types, slide ids resolve. Returns the slide part names. */
function expectConsistentDeck(parts: Map<string, string>, slides: number): string[] {
  const slideParts = [...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  expect(slideParts).toHaveLength(slides);
  for (const [name, text] of parts) {
    if (!name.endsWith(".rels")) continue;
    const base = name.replace(/_rels\/[^/]*$/, "");
    for (const [rel] of text.matchAll(/<Relationship [^>]*>/g)) {
      if (rel.includes('TargetMode="External"')) continue;
      const target = /Target="([^"]+)"/.exec(rel)?.[1] as string;
      const resolved = new URL(target, `http://x/${base}`).pathname.slice(1);
      expect(parts.has(resolved), `${name} -> ${resolved}`).toBe(true);
    }
  }
  const types = parts.get("[Content_Types].xml") as string;
  for (const slide of slideParts) expect(types).toContain(`PartName="/${slide}"`);
  const rels = parts.get("ppt/_rels/presentation.xml.rels") as string;
  for (const [, id] of (parts.get("ppt/presentation.xml") as string).matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)) {
    expect(rels).toContain(`Id="${id}"`);
  }
  return slideParts;
}

describe("sample decks (tools/make-fixtures.mjs)", () => {
  for (const [file, slides] of [
    ["sample-deck.pptx", 3],
    ["quarterly-review.pptx", 2],
  ] as const) {
    it(`${file} is a small, well-formed Office Open XML package with ${slides} slides`, () => {
      expect(statSync(new URL(file, decks)).size).toBeLessThan(50_000);
      const parts = unzip(read(file));
      expect([...parts.keys()][0]).toBe("[Content_Types].xml");
      for (const required of [
        "_rels/.rels",
        "ppt/presentation.xml",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/theme/theme1.xml",
      ]) {
        expect(parts.has(required), required).toBe(true);
      }
      const slideParts = expectConsistentDeck(parts, slides);
      for (const slide of slideParts) expect(parts.get(slide)).toMatch(/<a:t>[^<]+<\/a:t>/);
    });
  }

  it("sample-handout.pdf is a small PDF whose cross-reference table points at every object", () => {
    const bytes = read("sample-handout.pdf");
    expect(bytes.length).toBeLessThan(50_000);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const entries = [...text.slice(xref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const [i, offset] of entries.entries()) expect(text.startsWith(`${i + 1} 0 obj\n`, offset)).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text.match(/\/Type \/Page /g)).toHaveLength(2);
  });
});

describe("demo files (src/worker/seams/file-source/demo-files)", () => {
  const demo = new URL("../../src/worker/seams/file-source/demo-files/", import.meta.url);
  const readDemo = (name: string) => new Uint8Array(readFileSync(new URL(name, demo)));

  it("demo-deck.pptx is a consistent 2-slide package with blank author fields", () => {
    const parts = unzip(readDemo("demo-deck.pptx"));
    expect([...parts.keys()][0]).toBe("[Content_Types].xml");
    expectConsistentDeck(parts, 2);
    const core = parts.get("docProps/core.xml") as string;
    expect(core).not.toMatch(/<dc:creator>[^<]/);
    expect(core).not.toMatch(/<cp:lastModifiedBy>[^<]/);
  });

  it("demo-handout.pdf is a PDF with blank author fields", () => {
    const text = Buffer.from(readDemo("demo-handout.pdf")).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).not.toMatch(/\/Author\s*\((?!\))/);
    expect(text).not.toMatch(/<dc:creator>\s*<rdf:Seq>\s*<rdf:li>[^<]/);
  });
});
