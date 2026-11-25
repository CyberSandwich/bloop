import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { scanPdf } from "../../src/worker/seams/guest-drop/pdf-scan.ts";

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
