import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_OBJECT_STREAMS, scanPdf } from "../../src/worker/seams/guest-drop/pdf-scan.ts";

const enc = new TextEncoder();
const pdf = (body: string) => enc.encode(`%PDF-1.5\n${body}\n%%EOF\n`);
const objStm = (inner: string, dictExtra = "/Filter /FlateDecode") => {
  const data = dictExtra.includes("Flate") ? deflateSync(enc.encode(inner)) : enc.encode(inner);
  const head = enc.encode(`5 0 obj\n<< /Type /ObjStm /N 1 /First 4 ${dictExtra} /Length ${data.length} >>\nstream\n`);
  const tail = enc.encode("\nendstream\nendobj\n");
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head);
  body.set(data, head.length);
  body.set(tail, head.length + data.length);
  const start = enc.encode("%PDF-1.5\n");
  const out = new Uint8Array(start.length + body.length + 6);
  out.set(start);
  out.set(body, start.length);
  out.set(enc.encode("%%EOF\n"), start.length + body.length);
  return out;
};

describe("DROP-13 pdf-active: clean files", () => {
  it("passes a plain PDF", async () => {
    expect(await scanPdf(pdf("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj"))).toEqual({ ok: true });
  });

  it("passes a content stream and a clean object stream", async () => {
    const clean = objStm("<< /Type /Page /Parent 2 0 R >>");
    expect(await scanPdf(clean)).toEqual({ ok: true });
  });

  it("does not match a longer name that merely starts the same", async () => {
    expect(await scanPdf(pdf("<< /JSON 1 /Launching 2 /OpenActions 3 /EmbeddedFileX 4 >>"))).toEqual({ ok: true });
  });
});

describe("DROP-13 pdf-active: refused names", () => {
  it.each(["JS", "JavaScript", "Launch", "EmbeddedFile", "EmbeddedFiles", "OpenAction"])(
    "refuses /%s",
    async (name) => {
      const verdict = await scanPdf(pdf(`1 0 obj\n<< /${name} 4 0 R >>\nendobj`));
      expect(verdict).toMatchObject({ ok: false, error: "macro_content", found: [name] });
    },
  );

  it("decodes hex-escaped names", async () => {
    expect(await scanPdf(pdf("<< /J#61vaScript 1 0 R >>"))).toMatchObject({ ok: false, found: ["JavaScript"] });
    expect(await scanPdf(pdf("<< /#4A#53 (app.alert(1)) >>"))).toMatchObject({ ok: false, found: ["JS"] });
    expect(await scanPdf(pdf("<< /Open#41ction [1 0 R /Fit] >>"))).toMatchObject({ ok: false, found: ["OpenAction"] });
  });

  it("reports every distinct name once", async () => {
    const verdict = await scanPdf(pdf("<< /JS 1 0 R /JS 2 0 R /Launch 3 0 R >>"));
    expect(verdict).toMatchObject({ ok: false, found: ["JS", "Launch"] });
  });

  it("refuses an encrypted file, whose streams cannot be read", async () => {
    expect(await scanPdf(pdf("trailer << /Encrypt 9 0 R >>"))).toMatchObject({ ok: false, found: ["Encrypt"] });
  });
});

describe("DROP-13 pdf-active: object streams", () => {
  it("finds a name inside a deflated object stream", async () => {
    const verdict = await scanPdf(objStm("<< /S /JavaScript /JS (app.alert(1)) >>"));
    expect(verdict).toMatchObject({ ok: false, found: ["JavaScript", "JS"] });
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
    const broken = objStm("x");
    const text = new TextDecoder("latin1")
      .decode(broken)
      .replace(/stream\n[\s\S]*\nendstream/, "stream\nnot deflate\nendstream");
    expect(await scanPdf(enc.encode(text))).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("refuses an object stream that inflates past the cap", async () => {
    const bomb = objStm(" ".repeat(9 * 1024 * 1024));
    expect(await scanPdf(bomb)).toMatchObject({ ok: false, found: ["unscannable"] });
  });
});

describe("DROP-13 pdf-active: hostile input", () => {
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const body = deflateSync(enc.encode("<</S/JavaScript/JS(app.alert(1))>>"));
  const stream = (dict: string, data: Uint8Array, eol = "\n") =>
    cat(enc.encode(`1 0 obj<<${dict}>>stream${eol}`), data, enc.encode("\nendstream endobj"));

  it("reads names split by NUL, which PDF treats as white space", async () => {
    const verdict = await scanPdf(
      enc.encode("%PDF-1.7\n1 0 obj<</S/JavaScript\x00/JS\x00(app.alert(1))>>endobj\n%%EOF"),
    );
    expect(verdict).toMatchObject({ ok: false, found: ["JavaScript", "JS"] });
  });

  it.each(["XFA", "AA", "GoToR", "GoToE", "SubmitForm", "ImportData", "RichMedia"])("refuses /%s", async (name) => {
    expect(await scanPdf(pdf(`<< /${name} 1 0 R >>`))).toMatchObject({ ok: false, found: [name] });
  });

  it("refuses an object stream dictionary with a key outside the plain form", async () => {
    const dict = "/Type/ObjStm/Filter/FlateDecode/Xobj 1";
    expect(await scanPdf(stream(dict, body))).toMatchObject({ ok: false, found: ["unscannable"] });
  });

  it("refuses an object stream whose keyword ends in a bare CR, which a reader may still take", async () => {
    const data = stream("/Type/ObjStm/Filter/FlateDecode", body, "\r");
    expect(await scanPdf(data)).toMatchObject({ ok: false, found: ["unscannable"] });
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

  it("scans a million stream keywords in linear time", async () => {
    const hostile = enc.encode(`1 0 obj ${"stream\n".repeat(150_000)}`);
    const t = performance.now();
    expect(await scanPdf(hostile)).toEqual({ ok: true });
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("stops at the first object stream it cannot read, however many follow", async () => {
    const hostile = enc.encode(`1 0 obj<</Type/ObjStm>>stream\n`.repeat(30_000));
    const t = performance.now();
    expect(await scanPdf(hostile)).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(performance.now() - t).toBeLessThan(500);
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
    const t = performance.now();
    expect(await scanPdf(hostile)).toMatchObject({ ok: false, found: ["unscannable"] });
    expect(performance.now() - t).toBeLessThan(10_000);
  }, 30_000);
});
