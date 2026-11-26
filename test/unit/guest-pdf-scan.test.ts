import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type ChunkSource,
  MAX_OBJECT_STREAMS,
  PDF_WINDOW_BYTES,
  SCAN_BUFFER_BYTES,
  scanPdf,
  scanPdfChunks,
} from "../../src/worker/seams/guest-drop/pdf-scan.ts";
import { CLEAN, concat as cat, forgedMarks, HOSTILE } from "../pdf-corpus.ts";

const enc = new TextEncoder();
const pdf = (body: string) => enc.encode(`%PDF-1.5\n${body}\n%%EOF\n`);
const objStm = (inner: string, dictExtra = "/Filter /FlateDecode") => {
  const data = dictExtra.includes("Flate") ? deflateSync(enc.encode(inner)) : enc.encode(inner);
  return cat([
    enc.encode(`%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 ${dictExtra} /Length ${data.length} >>\nstream\n`),
    data,
    enc.encode("\nendstream\nendobj\n%%EOF\n"),
  ]);
};
const body = deflateSync(enc.encode("<</S/JavaScript/JS(app.alert(1))>>"));
const stream = (dict: string, data: Uint8Array, eol = "\n") =>
  cat([enc.encode(`1 0 obj<<${dict}>>stream${eol}`), data, enc.encode("\nendstream endobj")]);

/** A source that hands out `bytes` in pieces of the given sizes, cycling through them. */
const pieces = (bytes: Uint8Array, sizes: number[]): ChunkSource => {
  let at = 0;
  let i = 0;
  return async () => {
    if (at >= bytes.length) return null;
    const n = sizes[i++ % sizes.length] as number;
    const chunk = bytes.subarray(at, at + n);
    at += n;
    return chunk;
  };
};
const chunked = (bytes: Uint8Array, size: number) => scanPdfChunks(pieces(bytes, [size]));
/** One scan with the bytes its searches may read summed: a counter, not a clock, so load cannot flake it. */
const worked = async (bytes: Uint8Array) => {
  let work = 0;
  const out = await scanPdfChunks(pieces(bytes, [bytes.length]), undefined, (n) => {
    work += n;
  });
  return { out, work };
};
const fixture = (path: string) => new Uint8Array(readFileSync(new URL(`../../${path}`, import.meta.url)));
const FILES: [string, Uint8Array][] = [["the sample handout", fixture("test/fixtures/decks/sample-handout.pdf")]];

/** An 8 MiB-class zlib stream that inflates to `inner`: empty stored blocks, then one stored block holding it. */
const storedPadding = (rawBytes: number, inner = "") => {
  const tail = enc.encode(inner);
  const blocks = Math.floor((rawBytes - 2 - 5 - tail.length - 4) / 5);
  const out = new Uint8Array(2 + blocks * 5 + 5 + tail.length + 4);
  out.set([0x78, 0x01]);
  for (let i = 0; i < blocks; i++) out.set([0x00, 0x00, 0x00, 0xff, 0xff], 2 + i * 5);
  const at = 2 + blocks * 5;
  out.set([0x01, tail.length & 255, tail.length >>> 8, ~tail.length & 255, (~tail.length >>> 8) & 255], at);
  out.set(tail, at + 5);
  let [a, b] = [1, 0];
  for (const c of tail) {
    a = (a + c) % 65521;
    b = (b + a) % 65521;
  }
  new DataView(out.buffer).setUint32(at + 5 + tail.length, ((b << 16) | a) >>> 0);
  return out;
};
const objStmOf = (data: Uint8Array) =>
  cat([
    enc.encode(`9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
    data,
    enc.encode("\nendstream\nendobj\n"),
  ]);

describe("DROP-13 pdf-active: clean files", () => {
  it("passes a plain PDF", async () => {
    expect(await scanPdf(pdf("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj"))).toEqual({ ok: true });
  });

  it("passes a content stream and a clean object stream", async () => {
    expect(await scanPdf(objStm("<< /Type /Page /Parent 2 0 R >>"))).toEqual({ ok: true });
  });

  it("does not match a longer name that merely starts the same", async () => {
    expect(await scanPdf(pdf("<< /JSON 1 /Launching 2 /GoToRx 3 /EmbeddedFileX 4 >>"))).toEqual({ ok: true });
  });

  it("passes an /OpenAction or /AA that only goes to a page or a destination (refused keys, not types)", async () => {
    for (const body of [
      "<< /Type /Catalog /OpenAction [ 3 0 R /Fit ] >>",
      "<< /Type /Catalog /Open#41ction [1 0 R /Fit] >>",
      "<< /Type /Catalog /OpenAction << /S /GoTo /D (section.1) >> >>",
      "<< /Type /Page /AA << /O << /S /GoTo /D [ 3 0 R /Fit ] >> /C << /S /GoTo /D (top) >> >> >>",
    ]) {
      expect(await scanPdf(pdf(body)), body).toEqual({ ok: true });
    }
  });

  it.each(CLEAN)("passes what %s writes", async (_, build) => {
    expect(await scanPdf(build())).toEqual({ ok: true });
  });

  it.each(FILES)("passes %s", async (_, bytes) => {
    expect(await scanPdf(bytes)).toEqual({ ok: true });
  });
});

describe("DROP-13 pdf-active: refused action types", () => {
  it.each([
    ...["JS", "JavaScript", "Launch", "EmbeddedFile", "EmbeddedFiles", "XFA"],
    ...["GoToR", "GoToE", "SubmitForm", "ImportData", "RichMedia", "EF", "FileAttachment", "RF"],
  ])("refuses /%s", async (name) => {
    const verdict = await scanPdf(pdf(`1 0 obj\n<< /${name} 4 0 R >>\nendobj`));
    expect(verdict).toMatchObject({ ok: false, error: "macro_content", found: [name] });
  });

  it.each(HOSTILE)("refuses %s", async (_, build, found) => {
    expect(await scanPdf(build())).toMatchObject({ ok: false, error: "macro_content", found });
  });

  it("refuses a dangerous type inside /OpenAction and /AA", async () => {
    expect(await scanPdf(pdf("<< /OpenAction << /S /Launch /F (x) >> >>"))).toMatchObject({ found: ["Launch"] });
    expect(await scanPdf(pdf("<< /AA << /O << /S /GoToR /F (x.pdf) >> >> >>"))).toMatchObject({ found: ["GoToR"] });
  });

  it("decodes hex-escaped names", async () => {
    expect(await scanPdf(pdf("<< /J#61vaScript 1 0 R >>"))).toMatchObject({ ok: false, found: ["JavaScript"] });
    expect(await scanPdf(pdf("<< /#4A#53 (app.alert(1)) >>"))).toMatchObject({ ok: false, found: ["JS"] });
    expect(await scanPdf(pdf("<< /S /La#75nch >>"))).toMatchObject({ ok: false, found: ["Launch"] });
  });

  it("reports every distinct name once, sorted", async () => {
    const verdict = await scanPdf(pdf("<< /Launch 3 0 R /JS 1 0 R /JS 2 0 R >>"));
    expect(verdict).toMatchObject({ ok: false, found: ["JS", "Launch"] });
  });

  it("refuses an encrypted file, whose streams cannot be read", async () => {
    expect(await scanPdf(pdf("trailer << /Encrypt 9 0 R >>"))).toMatchObject({ ok: false, found: ["Encrypt"] });
  });

  it("still finds Encrypt after an object stream it cannot read (an encrypted file's object streams are ciphertext)", async () => {
    const encrypted = cat([objStm("x", "/Filter /LZWDecode"), enc.encode("trailer << /Encrypt 9 0 R >>\n%%EOF\n")]);
    expect(await scanPdf(encrypted)).toMatchObject({ ok: false, found: ["Encrypt", "unscannable"] });
  });
});

describe("DROP-13 pdf-active: object streams", () => {
  it("finds a name inside a deflated object stream", async () => {
    const verdict = await scanPdf(objStm("<< /S /JavaScript /JS (app.alert(1)) >>"));
    expect(verdict).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
  });

  it("finds a hex-escaped name inside an object stream", async () => {
    expect(await scanPdf(objStm("<< /La#75nch 1 0 R >>"))).toMatchObject({ ok: false, found: ["Launch"] });
  });

  it("refuses an object stream it cannot read", async () => {
    expect(await scanPdf(objStm("whatever", "/Filter /LZWDecode"))).toMatchObject({
      ok: false,
      found: ["unscannable"],
    });
    expect(await scanPdf(objStm("whatever", "/Filter [/ASCIIHexDecode /FlateDecode]"))).toMatchObject({
      ok: false,
      found: ["unscannable"],
    });
  });

  it("refuses a Flate object stream that does not inflate", async () => {
    const text = new TextDecoder("latin1")
      .decode(objStm("x"))
      .replace(/stream\n[\s\S]*\nendstream/, "stream\nnot deflate\nendstream");
    expect(await scanPdf(enc.encode(text))).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("refuses an object stream that inflates past the cap", async () => {
    expect(await scanPdf(objStm(" ".repeat(9 * 1024 * 1024)))).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("DROP-13 pdf-active: a decoy that balances the object stream count does not hide a padded object stream (fail-open)", async () => {
    const decoy = cat([
      enc.encode("1 0 obj<</Filter/FlateDecode/Type/ObjStmstream\n"),
      deflateSync(enc.encode("<<>>")),
    ]);
    const hidden = deflateSync(enc.encode("1 0 <</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>"));
    const file = cat([
      enc.encode("%PDF-1.5\n"),
      decoy,
      enc.encode("endstream endobj\n2 0 obj<</Type/ObjStm/N 1/First 4/Filter/FlateDecode"),
      enc.encode(" ".repeat(5000)),
      enc.encode(`/Length ${hidden.length}>>stream\n`),
      hidden,
      enc.encode("\nendstream endobj\n%%EOF\n"),
    ]);
    expect(await scanPdf(file)).toMatchObject({ ok: false, found: ["unscannable"] });
    for (const size of [1, 100, 4096, 9000, file.length]) {
      expect(await chunked(file, size), `window ${size}`).toMatchObject({ ok: false, found: ["unscannable"] });
    }
  });

  it("refuses an /ObjStm token outside every scanned object stream dictionary", async () => {
    const clean = stream("/Type/ObjStm/N 1/First 4/Filter/FlateDecode", deflateSync(enc.encode("1 0 <<>>")));
    const file = cat([enc.encode("%PDF-1.5\n"), clean, enc.encode("\n3 0 obj<</Note/ObjStm>>endobj\n%%EOF\n")]);
    expect(await scanPdf(file)).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(await scanPdf(cat([enc.encode("%PDF-1.5\n"), clean, enc.encode("\n%%EOF\n")]))).toEqual({ ok: true });
  });
});

describe("DROP-13 pdf-active: hostile input", () => {
  it("reads names split by NUL, which PDF treats as white space", async () => {
    const verdict = await scanPdf(
      enc.encode("%PDF-1.7\n1 0 obj<</S/JavaScript\x00/JS\x00(app.alert(1))>>endobj\n%%EOF"),
    );
    expect(verdict).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
  });

  it("refuses an object stream dictionary with a key outside the plain form", async () => {
    const dict = "/Type/ObjStm/Filter/FlateDecode/Xobj 1";
    expect(await scanPdf(stream(dict, body))).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("DROP-13 pdf-active: reads an object stream whose keyword ends in a bare CR, which a reader takes (stream\\r skipped)", async () => {
    const data = stream("/Type/ObjStm/N 1/First 4/Filter/FlateDecode", body, "\r");
    expect(await scanPdf(data)).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
    const untyped = stream("/N 1/First 4/Filter/FlateDecode", body, "\r");
    expect(await scanPdf(untyped)).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
  });

  it("DROP-13 pdf-active: reads an object stream with /N and /First but no /Type through both scans (untyped bypass)", async () => {
    const poc = HOSTILE.find(([name]) => name.includes("no /Type"))?.[1]() as Uint8Array;
    expect(await scanPdf(poc)).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
    for (const size of [1, 64, 4096, poc.length]) {
      expect(await chunked(poc, size), `window ${size}`).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
    }
  });

  it("DROP-13 pdf-active: refuses a reference /First whose object meets a stream before its endobj (reference bypass)", async () => {
    const poc = HOSTILE.find(([name]) => name.includes("/First is a reference"))?.[1]() as Uint8Array;
    for (const size of [1, 64, 4096, poc.length]) {
      expect(await chunked(poc, size), `window ${size}`).toMatchObject({ ok: false, found: ["unscannable"] });
    }
    const unread = stream(`/First 2 0 R/Length 9${" ".repeat(5000)}`, enc.encode("123456789"));
    expect(await scanPdf(unread)).toMatchObject({ ok: false, found: ["unscannable"] });
    const unclosed = pdf("1 0 obj<</Type/Outlines/First 2 0 R/Last 2 0 R/Count 1>>");
    expect(await scanPdf(unclosed)).toMatchObject({ ok: false, found: ["unscannable"] });
    const named = pdf("1 0 obj<</First 2 0 R/X/endobj>>\n2 0 obj<</Length 1>>stream\nx\nendstream\nendobj");
    expect(await scanPdf(named)).toMatchObject({ ok: false, found: ["unscannable"] });
    const closed = pdf("1 0 obj<</First 2 0 R>>endobj\n2 0 obj<</Length 1>>stream\nx\nendstream\nendobj");
    expect(await scanPdf(closed)).toEqual({ ok: true });
    const inner = deflateSync(enc.encode("<<>>"));
    const read = cat([
      enc.encode(
        `%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 6 0 R /Filter /FlateDecode /Length ${inner.length} >>`,
      ),
      enc.encode("\nstream\n"),
      inner,
      enc.encode("\nendstream\nendobj\n6 0 obj 4 endobj\n%%EOF\n"),
    ]);
    expect(await scanPdf(read)).toEqual({ ok: true });
  });

  it("DROP-13 pdf-active: refuses a reference /First whose endobj follows a stream word with white space before its EOL (endobj released it)", async () => {
    const poc = HOSTILE.find(([name]) => name.includes("white space before its EOL"))?.[1]() as Uint8Array;
    for (const size of [1, 64, 4096, poc.length]) {
      expect(await chunked(poc, size), `window ${size}`).toMatchObject({ ok: false, found: ["unscannable"] });
    }
  });

  it("DROP-13 pdf-active: keywords hidden in a string or comment cannot steer the scan off an object stream (forged marks, fail-open)", async () => {
    const long = "a".repeat(5000);
    for (const hide of [
      "/X ( endobj ) /Y ( obj<< )",
      "/X (a \\( endobj ) /Y ((nested) obj<< )",
      "% endobj obj<<\n/Z 1",
      "/X ( endobj ) /Y 1 0 obj<< /Z",
      `/X (${long} endobj obj<< )`,
      `% ${long} endobj obj<<\n/Z 1`,
    ]) {
      const poc = forgedMarks(hide);
      for (const size of [1, 64, 4096, poc.length]) {
        expect(await chunked(poc, size), `${hide.slice(0, 40)} at ${size}`).toMatchObject({
          ok: false,
          found: ["unscannable"],
        });
      }
    }
    expect(await scanPdf(forgedMarks(""))).toMatchObject({ ok: false, found: ["JavaScript"] });
  });

  it("DROP-13 pdf-active: a run of unclosed strings and comments costs one lookback, not one per byte (scan stays linear)", async () => {
    for (const run of ["(", "%", "(%", "((((\\"]) {
      const poc = pdf(`1 0 obj<<${run.repeat(200_000)}`);
      const { out, work } = await worked(poc);
      expect(out).toMatchObject({ ok: false, found: ["unscannable"] });
      // The names, the header comment and the first unclosed lookahead: every later one is skipped.
      expect(work, `run ${run}`).toBeLessThanOrEqual(3 * poc.length);
    }
  });

  it("DROP-13 pdf-active: an object that begins inside another stream's data is refused, binary data with stray brackets passes", async () => {
    const hosted = pdf(
      "1 0 obj<</Length 99>>stream\nxx\n5 0 obj<< /N 1 /First 4 0 R >>\nendstream\nendobj\n4 0 obj 5 endobj",
    );
    expect(await scanPdf(hosted)).toMatchObject({ ok: false, found: ["unscannable"] });
    const binary = cat([
      enc.encode("%PDF-1.5\n1 0 obj<</Length 9>>stream\n"),
      enc.encode("(\x00%\x01( "),
      enc.encode("\nendstream\nendobj\n2 0 obj<</First 3 0 R>>endobj\n3 0 obj 1 endobj\n%%EOF\n"),
    ]);
    for (const size of [1, 7, binary.length]) expect(await chunked(binary, size)).toEqual({ ok: true });
  });

  it("passes a bare stream word with no reference /First pending (a title, a stray keyword)", async () => {
    const bare = pdf("1 0 obj<</Title (a stream of slides)>>endobj\n2 0 obj<</X 1>>stream endobj");
    expect(await scanPdf(bare)).toEqual({ ok: true });
  });

  it("refuses a reference /First followed in its object by a stream word with no EOL (endobj released it)", async () => {
    const spaced = pdf("1 0 obj<</First 2 0 R/Length 1>>stream x\nendstream\nendobj");
    expect(await scanPdf(spaced)).toMatchObject({ ok: false, found: ["unscannable"] });
    // Read from right after the word, the bytes inflate as a clean object stream: only the word itself refuses it.
    const data = deflateSync(enc.encode("<<>>"));
    const glued = cat([
      enc.encode(`%PDF-1.5\n5 0 obj<</Type/ObjStm/N 1/First 6 0 R/Filter/FlateDecode/Length ${data.length}>>stream`),
      data,
      enc.encode("\nendstream\nendobj\n6 0 obj 4 endobj\n%%EOF\n"),
    ]);
    expect(await scanPdf(glued)).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("DROP-13 pdf-active: refuses a direct /First the scan cannot tie to an object stream it read (far or split dictionary)", async () => {
    const far = stream(`/N 1/First 4/Filter/FlateDecode${" ".repeat(5000)}/Length 9`, body);
    expect(await scanPdf(far)).toMatchObject({ ok: false, found: ["unscannable"] });
    const split = stream("/N 1/First 4/Filter/FlateDecode 9 0 obj<</Length 9", body);
    expect(await scanPdf(split)).toMatchObject({ ok: false, found: ["unscannable"] });
    const outline = pdf("1 0 obj<</Type/Outlines/First 2 0 R/Last 2 0 R/Count 1>>endobj");
    expect(await scanPdf(outline)).toEqual({ ok: true });
  });

  it("refuses an object stream whose keyword is followed by a space", async () => {
    const data = stream("/Type/ObjStm/Filter/FlateDecode", body, " \n");
    expect(await scanPdf(data)).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("refuses a Flate filter array and a double Flate", async () => {
    const twice = stream("/Type/ObjStm/Filter[/FlateDecode/FlateDecode]", deflateSync(body));
    expect(await scanPdf(twice)).toMatchObject({ ok: false, found: ["unscannable"] });
    const hex = stream("/Type/ObjStm/Filter[/FlateDecode/AHx]", deflateSync(enc.encode("3c3c2f4a53283129")));
    expect(await scanPdf(hex)).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it.each([
    "/Filter/AHx",
    "/Filter/A85",
    "/Filter/LZW",
    "/Filter/RL",
    "/Filter/FlateDecode/DecodeParms<</Predictor 12>>",
  ])("refuses the filter form %s", async (form) => {
    expect(await scanPdf(stream(`/Type/ObjStm${form}`, body))).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("refuses an object stream whose dictionary starts more than 4 KB back", async () => {
    const padded = stream(`/Type/ObjStm/Filter/FlateDecode/Length ${" ".repeat(5000)}1`, body);
    expect(await scanPdf(padded)).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("does not take a dictionary opened more than 64 white-space bytes after `obj` (unbounded `obj\\s*<<`)", async () => {
    const far = enc.encode(`5 0 obj${" ".repeat(65)}<</Type/ObjStm/N 1/First 4/Filter/FlateDecode>>stream\n`);
    const file = cat([enc.encode("%PDF-1.5\n"), far, body, enc.encode("\nendstream\n%%EOF\n")]);
    expect(await scanPdf(file)).toMatchObject({ ok: false, found: ["unscannable"] });
    const near = enc.encode(`5 0 obj${" ".repeat(64)}<</Type/ObjStm/N 1/First 4/Filter/FlateDecode>>stream\n`);
    const ok = cat([enc.encode("%PDF-1.5\n"), near, body, enc.encode("\nendstream\n%%EOF\n")]);
    expect(await scanPdf(ok)).toMatchObject({ ok: false, found: ["JS", "JavaScript"] });
  });

  it("scans a million stream keywords in linear time", async () => {
    const hostile = enc.encode(`1 0 obj ${"stream\n".repeat(150_000)}`);
    const { out, work } = await worked(hostile);
    expect(out).toEqual({ ok: true });
    expect(work).toBeLessThanOrEqual(3 * hostile.length);
  });

  it("scans a hundred thousand endobj keywords, each closing a reference /First, in linear time", async () => {
    const hostile = enc.encode(`1 0 obj ${"<</First 2 0 R>>endobj ".repeat(100_000)}${"endobj\n".repeat(100_000)}`);
    const { out, work } = await worked(hostile);
    expect(out).toEqual({ ok: true });
    expect(work).toBeLessThanOrEqual(3 * hostile.length);
  });

  it("stops inflating at the first object stream it cannot read, however many follow", async () => {
    const hostile = enc.encode(`1 0 obj<</Type/ObjStm>>stream\n`.repeat(30_000));
    const { out, work } = await worked(hostile);
    expect(out).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(work).toBeLessThanOrEqual(3 * hostile.length);
  });

  it("caps the object streams it inflates, and stays fast on a hundred thousand", async () => {
    const unit = stream("/Type/ObjStm/Filter/FlateDecode", deflateSync(enc.encode("<<>>")));
    const repeat = (n: number) => {
      const out = new Uint8Array(unit.length * n);
      for (let i = 0; i < n; i++) out.set(unit, i * unit.length);
      return out;
    };
    expect(await scanPdf(repeat(MAX_OBJECT_STREAMS))).toEqual({ ok: true });
    const hostile = repeat(100_000);
    const { out, work } = await worked(hostile);
    expect(out).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(work).toBeLessThanOrEqual(3 * hostile.length);
  }, 30_000);

  it("inflates at most 32 MiB over all object streams, and refuses the stream that would pass it", async () => {
    const seven = objStmOf(new Uint8Array(deflateSync(new Uint8Array(7 * 1024 * 1024).fill(0x20))));
    const file = (n: number) => cat([enc.encode("%PDF-1.5\n"), ...Array.from({ length: n }, () => seven)]);
    expect(await scanPdf(file(4))).toEqual({ ok: true });
    expect(await scanPdf(file(5))).toMatchObject({ ok: false, found: ["unscannable"] });
  }, 30_000);
});

describe("DROP-13 pdf-active: bounded memory", () => {
  const link = objStmOf(storedPadding(PDF_WINDOW_BYTES - 64));
  const chain = cat([enc.encode("%PDF-1.5\n"), ...Array.from({ length: 5 }, () => link), enc.encode("%%EOF\n")]);
  const peakOf = async (source: ChunkSource) => {
    let peak = 0;
    const verdict = await scanPdfChunks(source, (bytes) => {
      peak = Math.max(peak, bytes);
    });
    return { verdict, peak };
  };

  it("DROP-13 pdf-active: the chunked buffer stays within SCAN_BUFFER_BYTES over a chain of 8 MiB object streams (unbounded growth)", async () => {
    const { verdict, peak } = await peakOf(pieces(chain, [PDF_WINDOW_BYTES]));
    expect(verdict).toEqual({ ok: true });
    expect(peak).toBeGreaterThan(PDF_WINDOW_BYTES);
    expect(peak).toBeLessThanOrEqual(SCAN_BUFFER_BYTES);
    expect(SCAN_BUFFER_BYTES).toBe(2 * PDF_WINDOW_BYTES + 3 * 4096);
  }, 60_000);

  it("DROP-13 pdf-active: takes a chunk larger than a window a window at a time (the join copied the whole chunk)", async () => {
    for (const size of [chain.length, 3 * PDF_WINDOW_BYTES + 5]) {
      const { verdict, peak } = await peakOf(pieces(chain, [size]));
      expect(verdict, `chunks of ${size}`).toEqual({ ok: true });
      expect(peak, `chunks of ${size}`).toBeLessThanOrEqual(SCAN_BUFFER_BYTES);
    }
  }, 60_000);
});

describe("DROP-13 pdf-active: the chunked and the whole scan agree", () => {
  it("DROP-13 pdf-active: an object stream over 8 MiB that inflates small gets one verdict from both scans", async () => {
    const big = cat([
      enc.encode("%PDF-1.5\n"),
      objStmOf(storedPadding(PDF_WINDOW_BYTES + 1024 * 1024, "1 0 <</Type/Page>>")),
      enc.encode("%%EOF\n"),
    ]);
    const whole = await scanPdf(big);
    expect(whole).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(await chunked(big, PDF_WINDOW_BYTES)).toEqual(whole);
    expect(await chunked(big, 1024 * 1024 + 7)).toEqual(whole);
  }, 60_000);

  it("DROP-13 pdf-active: stops reading an object stream at its cap, its buffer within SCAN_BUFFER_BYTES (read on to endstream)", async () => {
    const huge = cat([
      enc.encode("%PDF-1.5\n"),
      objStmOf(storedPadding(3 * PDF_WINDOW_BYTES, "1 0 <</Type/Page>>")),
      enc.encode("%%EOF\n"),
    ]);
    let peak = 0;
    const verdict = await scanPdfChunks(pieces(huge, [PDF_WINDOW_BYTES]), (bytes) => {
      peak = Math.max(peak, bytes);
    });
    expect(verdict).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(peak).toBeLessThanOrEqual(SCAN_BUFFER_BYTES);
  }, 60_000);

  /** Deterministic so a failure reproduces. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const NOISE = [
    " ",
    "\n",
    "\x00",
    "% a comment\n",
    "stream\n",
    "obj<<",
    "endstream",
    "/ObjStm",
    "/JS",
    "/Open#41ction",
    "obj                                                                  <<",
    "\xff\xfe\x80",
  ];
  /** `base` with noise inserted at a few random places. */
  const mutate = (base: Uint8Array, rand: () => number) => {
    const parts: Uint8Array[] = [];
    let at = 0;
    const cuts = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => Math.floor(rand() * base.length)).sort(
      (a, b) => a - b,
    );
    for (const cut of cuts) {
      parts.push(base.subarray(at, cut));
      const noise = NOISE[Math.floor(rand() * NOISE.length)] as string;
      const pad = rand() < 0.3 ? " ".repeat(Math.floor(rand() * 9000)) : "";
      parts.push(Uint8Array.from(pad + noise, (c) => c.charCodeAt(0)));
      at = cut;
    }
    parts.push(base.subarray(at));
    return cat(parts);
  };

  const small: Uint8Array[] = [
    pdf("1 0 obj\n<< /Type /Catalog >>\nendobj"),
    objStm("<< /Type /Page >>"),
    objStm("<< /S /JavaScript >>"),
    objStm("x", "/Filter /LZWDecode"),
    stream("/Type/ObjStm/Filter/FlateDecode", body, "\r"),
    stream(`/Type/ObjStm/Filter/FlateDecode/Length ${" ".repeat(5000)}1`, body),
    pdf(`/JavaScript${"x".repeat(9000)}`),
    pdf("trailer << /Encrypt 9 0 R >>"),
    cat([enc.encode("%PDF-1.5\n5 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\n"), body, enc.encode("\nendstream")]),
    cat([enc.encode(`%PDF-1.5\n1 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\n`), deflateSync(enc.encode("<<>>"))]),
    cat([objStm("x", "/Filter /LZWDecode"), pdf("<< /S /Launch >> trailer << /Encrypt 1 0 R >>")]),
  ];
  const corpus: Uint8Array[] = [
    ...small,
    ...CLEAN.map(([, build]) => build()),
    ...HOSTILE.map(([, build]) => build()),
    ...FILES.map(([, bytes]) => bytes),
  ];

  it("gives the same verdict at every window size over the corpus and random mutations of it", async () => {
    const rand = random(13);
    const inputs = [...corpus, ...corpus.flatMap((base) => Array.from({ length: 4 }, () => mutate(base, rand)))];
    for (const [i, bytes] of inputs.entries()) {
      const whole = await scanPdf(bytes);
      const sizes = [7, 64, 4095, 8193, 20_011, bytes.length + 5];
      if (bytes.length < 8_000) sizes.push(1);
      for (const size of sizes) expect(await chunked(bytes, size), `input ${i}, window ${size}`).toEqual(whole);
      const split = Array.from({ length: 16 }, () => 1 + Math.floor(rand() * 3000));
      expect(await scanPdfChunks(pieces(bytes, split)), `input ${i}, split ${split}`).toEqual(whole);
    }
  }, 120_000);
});
