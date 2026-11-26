// @ts-nocheck: a plain script that builds string templates; test/unit/mock-source.test.ts checks what it writes.
// Writes bloop's own sample deck, "Welcome to bloop", and its PDF export into src/worker/seams/file-source/demo-files/:
//   demo-deck.pptx   Office Open XML written here, zipped with tools/zip.mjs (no template, image or font is embedded)
//   demo-handout.pdf the deck exported by LibreOffice (soffice on PATH or in /Applications)
// The deck is original: native shapes in design.md's paper, ink and robin tokens, and the logo drawn from
// public/favicon.svg. Text is Calibri, which every Windows PowerPoint has. The pptx is byte-for-byte reproducible.
// Run: node tools/make-demo-deck.mjs, then python3 -I tools/render-slides.py for the demo screen's page images.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./zip.mjs";

const OUT = fileURLToPath(new URL("../src/worker/seams/file-source/demo-files/", import.meta.url));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

// design.md's color tokens, without the "#".
const C = {
  paper: "F3F3F0",
  white: "FFFFFF",
  ink: "1E1E1C",
  ink2: "3A3A36",
  muted: "66665F",
  lead: "50504B",
  g1: "DCDCD7",
  hairline: "E1E1DD",
  robin: "F4BA8B",
  rose: "F8D7D3",
  roseInk: "9B2C22",
  logoGray: "646464",
};
const FONT = "Calibri";
const E = (inches) => Math.round(inches * 914400);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rels = (items) =>
  `${XML}<Relationships xmlns="${REL_NS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;

const color = (hex, alpha) =>
  alpha == null ? `<a:srgbClr val="${hex}"/>` : `<a:srgbClr val="${hex}"><a:alpha val="${alpha * 1000}"/></a:srgbClr>`;
const solid = (hex, alpha) => `<a:solidFill>${color(hex, alpha)}</a:solidFill>`;
const stroke = (hex, pt, extra = "") => `<a:ln w="${Math.round(pt * 12700)}"${extra}>${solid(hex)}</a:ln>`;

/** One slide's shapes: `ids` hands out unique shape ids. */
function builder() {
  let next = 1;
  const id = () => ++next;
  const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${E(x)}" y="${E(y)}"/><a:ext cx="${E(w)}" cy="${E(h)}"/></a:xfrm>`;

  /** @param {{t: string, sz?: number, b?: boolean, color?: string}[]} runs */
  const para = (runs, { algn = "l", before = 0 } = {}) =>
    `<a:p><a:pPr algn="${algn}"><a:spcBef><a:spcPts val="${before * 100}"/></a:spcBef></a:pPr>${runs
      .map(
        ({ t, sz = 18, b = false, color: c = C.ink }) =>
          `<a:r><a:rPr lang="en-US" sz="${sz * 100}" b="${b ? 1 : 0}" dirty="0">${solid(c)}<a:latin typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:rPr><a:t>${esc(t)}</a:t></a:r>`,
      )
      .join("")}</a:p>`;

  /**
   * A shape. `geom` is a preset name or a ready custGeom; `radius` (inches) rounds a roundRect; `text` is paragraphs.
   */
  const shape = ({
    name,
    x,
    y,
    w,
    h,
    geom = "rect",
    radius,
    fill,
    alpha,
    line,
    text,
    anchor = "t",
    inset = 0,
    descr,
    txBox = false,
  }) => {
    const prst =
      geom === "roundRect"
        ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(50000, Math.round((radius / Math.min(w, h)) * 100000))}"/></a:avLst></a:prstGeom>`
        : geom.startsWith("<")
          ? geom
          : `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>`;
    const body = text
      ? `<p:txBody><a:bodyPr wrap="square" lIns="${E(inset)}" tIns="${E(inset)}" rIns="${E(inset)}" bIns="${E(inset)}" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${text.join("")}</p:txBody>`
      : `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>`;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="${esc(name)}"${descr ? ` descr="${esc(descr)}"` : ""}/><p:cNvSpPr${txBox ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h)}${prst}${fill ? solid(fill, alpha) : "<a:noFill/>"}${line ? stroke(line.color, line.pt) : "<a:ln><a:noFill/></a:ln>"}</p:spPr>${body}</p:sp>`;
  };

  const textBox = (name, x, y, w, h, paragraphs, anchor = "t") =>
    shape({ name, x, y, w, h, text: paragraphs, anchor, txBox: true });

  /** A custGeom made of path commands in a w x h grid. Paths: [{ d: [["M", x, y], ["L", x, y], ["C", ...6]], close, stroke }] */
  const cust = (w, h, paths) => {
    const pt = (x, y) => `<a:pt x="${x}" y="${y}"/>`;
    const sub = ({ d, close = true }) =>
      d
        .map(([op, ...n]) =>
          op === "M"
            ? `<a:moveTo>${pt(n[0], n[1])}</a:moveTo>`
            : op === "L"
              ? `<a:lnTo>${pt(n[0], n[1])}</a:lnTo>`
              : `<a:cubicBezTo>${pt(n[0], n[1])}${pt(n[2], n[3])}${pt(n[4], n[5])}</a:cubicBezTo>`,
        )
        .join("") + (close ? "<a:close/>" : "");
    // One path: its subpaths wind opposite ways where a hole is wanted. Strokes (close: false) are not filled.
    const open = paths.every((p) => p.close === false);
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}"${open ? ' fill="none"' : ""}>${paths.map(sub).join("")}</a:path></a:pathLst></a:custGeom>`;
  };

  /** The logo (public/favicon.svg) as native shapes: the disc is `size` wide, the "b" may stand a little above and below it. */
  const logo = (x, y, size, name = "bloop logo") => {
    const s = size / 602;
    const [bx, by] = [x - 39 * s, y - 35 * s];
    const disc = `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Disc"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="239" y="239"/><a:ext cx="602" cy="602"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>${solid(C.robin)}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
    const b = cust(680, 680, [
      {
        d: [
          ["M", 117, 15],
          ["L", 245, 15],
          ["L", 245, 255],
          ["C", 272, 196, 322, 169, 387, 169],
          ["C", 502, 169, 582, 261, 582, 417],
          ["C", 582, 573, 502, 664, 387, 664],
          ["C", 322, 664, 274, 636, 249, 580],
          ["L", 243, 580],
          ["L", 243, 656],
          ["L", 117, 656],
        ],
      },
      {
        d: [
          ["M", 347, 272],
          ["C", 286, 272, 243, 324, 243, 417],
          ["C", 243, 510, 286, 562, 347, 562],
          ["C", 408, 562, 451, 510, 451, 417],
          ["C", 451, 324, 408, 272, 347, 272],
        ],
      },
    ]);
    const mark = `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="200" y="204"/><a:ext cx="680" cy="680"/></a:xfrm>${b}${solid(C.logoGray)}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
    return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id()}" name="${name}" descr="The bloop logo, a gray b on an orange disc"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${E(bx)}" y="${E(by)}"/><a:ext cx="${E(680 * s)}" cy="${E(680 * s)}"/><a:chOff x="200" y="204"/><a:chExt cx="680" cy="680"/></a:xfrm></p:grpSpPr>${disc}${mark}</p:grpSp>`;
  };

  /** A tick or a cross, stroked, on a disc: `kind` is "tick" or "cross". */
  const badge = (kind, x, y, size, fill, ink) => {
    const g =
      kind === "tick"
        ? [{ d: [["M", 26, 52], ["L", 43, 69], ["L", 76, 31]], close: false, open: true }]
        : [
            { d: [["M", 30, 30], ["L", 70, 70]], close: false, open: true },
            { d: [["M", 70, 30], ["L", 30, 70]], close: false, open: true },
          ];
    const glyph = `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="${kind}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, size, size)}${cust(100, 100, g)}<a:noFill/>${stroke(ink, size * 6, ' cap="rnd"')}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
    return shape({ name: `${kind} disc`, x, y, w: size, h: size, geom: "ellipse", fill }) + glyph;
  };

  /** A numbered disc: ink with a white digit. */
  const numberDisc = (n, x, y, size, pt) =>
    shape({
      name: `Step ${n}`,
      x,
      y,
      w: size,
      h: size,
      geom: "ellipse",
      fill: C.ink,
      anchor: "ctr",
      text: [para([{ t: String(n), sz: pt, b: true, color: C.white }], { algn: "ctr" })],
    });

  const card = (name, x, y, w, h, extra = {}) =>
    shape({ name, x, y, w, h, geom: "roundRect", radius: 0.25, fill: C.white, line: { color: C.hairline, pt: 0.75 }, ...extra });

  const title = (text, { x = 0.8, y = 0.55, w = 11.73, h = 0.95, ph = "title" } = {}) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${ph}"/></p:nvPr></p:nvSpPr><p:spPr>${ph === "ctrTitle" ? xfrm(x, y, w, h) : ""}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;

  const lead = (text, y = 1.45) =>
    textBox("Lead", 0.8, y, 11.73, 0.5, [para([{ t: text, sz: 20, color: C.lead }])]);

  return { shape, textBox, para, cust, logo, badge, numberDisc, card, title, lead, xfrm };
}

const slideXml = (shapes, layout) =>
  `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

/** The slides: [layout number, shapes]. Wording follows content/security.md and the how-bloop-works article. */
function slides() {
  const out = [];

  {
    const s = builder();
    out.push([
      2,
      [
        s.shape({ name: "Warm Circle", x: 8.6, y: -0.9, w: 7.6, h: 7.6, geom: "ellipse", fill: C.robin, alpha: 40 }),
        s.shape({ name: "Small Warm Circle", x: 7.6, y: 3.9, w: 4.2, h: 4.2, geom: "ellipse", fill: C.robin, alpha: 24 }),
        s.logo(0.8, 1.0, 1.0),
        s.textBox("Wordmark", 2.0, 1.12, 3, 0.8, [s.para([{ t: "bloop", sz: 34, b: true }])], "ctr"),
        s.title("Welcome to bloop", { x: 0.8, y: 2.55, w: 8.2, h: 1.3, ph: "ctrTitle" }),
        s.textBox("Subtitle", 0.8, 3.95, 7.4, 1.0, [s.para([{ t: "A short guide to presenting with bloop.", sz: 26, color: C.lead }])]),
        s.textBox("Four Words", 0.8, 5.35, 7.4, 0.5, [s.para([{ t: "Scan. Approve. Show. End.", sz: 20, b: true, color: C.ink2 }])]),
      ],
    ]);
  }

  {
    const s = builder();
    const steps = [
      ["Scan", "The room PC shows a code. Your phone scans it."],
      ["Approve", "Choose your files on your phone and tap Approve."],
      ["Show", "The screen opens only the files you approved."],
      ["End", "End it from your phone or the screen, or let it time out."],
    ];
    const shapes = [s.title("How It Works"), s.lead("Four steps, from the room PC to a finished session.")];
    steps.forEach(([head, line], i) => {
      const x = 0.8 + i * 3.01;
      shapes.push(
        s.card(`Card ${i + 1}`, x, 2.3, 2.71, 3.3),
        s.numberDisc(i + 1, x + 0.35, 2.7, 0.62, 22),
        s.textBox(`Step ${i + 1} Title`, x + 0.3, 3.55, 2.2, 0.55, [s.para([{ t: head, sz: 26, b: true }])]),
        s.textBox(`Step ${i + 1} Line`, x + 0.3, 4.15, 2.2, 1.3, [s.para([{ t: line, sz: 17, color: C.muted }])]),
      );
    });
    shapes.push(
      s.textBox("Note", 0.8, 5.95, 11.73, 0.5, [
        s.para([{ t: "Nothing is typed on the room PC, and it never signs in to your account.", sz: 18, color: C.ink2 }]),
      ]),
    );
    out.push([1, shapes]);
  }

  {
    const s = builder();
    const rows = [
      ["Open bloop on the room PC.", "It shows a QR code and a typed code."],
      ["Scan the code with your phone camera.", "Or type the code on your phone."],
      ["Match the number.", "Your phone and the screen show the same two digits."],
    ];
    const shapes = [s.title("Scan the Screen’s Code")];
    rows.forEach(([head, line], i) => {
      const y = 1.95 + i * 1.3;
      shapes.push(
        s.numberDisc(i + 1, 0.8, y, 0.56, 20),
        s.textBox(`Row ${i + 1}`, 1.65, y - 0.06, 5.7, 1.1, [
          s.para([{ t: head, sz: 22, b: true }]),
          s.para([{ t: line, sz: 18, color: C.muted }], { before: 3 }),
        ]),
      );
    });
    shapes.push(
      s.shape({
        name: "Code Lifetime",
        x: 0.8,
        y: 5.95,
        w: 5.6,
        h: 0.5,
        geom: "roundRect",
        radius: 0.25,
        fill: C.white,
        line: { color: C.hairline, pt: 0.75 },
        anchor: "ctr",
        inset: 0.2,
        text: [s.para([{ t: "A code works once and lasts 60 seconds.", sz: 16, color: C.ink2 }])],
      }),
    );
    // A stylized code card: three finder squares and a fixed scatter of modules (not a real, scannable code).
    const N = 13;
    const finder = (x0, y0) => [
      { d: [["M", x0, y0], ["L", x0 + 5, y0], ["L", x0 + 5, y0 + 5], ["L", x0, y0 + 5]] },
      { d: [["M", x0 + 1, y0 + 1], ["L", x0 + 1, y0 + 4], ["L", x0 + 4, y0 + 4], ["L", x0 + 4, y0 + 1]] },
      { d: [["M", x0 + 2, y0 + 2], ["L", x0 + 3, y0 + 2], ["L", x0 + 3, y0 + 3], ["L", x0 + 2, y0 + 3]] },
    ];
    const paths = [...finder(0, 0), ...finder(N - 5, 0), ...finder(0, N - 5)];
    let seed = 7;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const inFinder = (c < 6 || c >= N - 6) && r < 6 ? true : c < 6 && r >= N - 6;
        seed = (seed * 1103515245 + 12345) % 2147483648;
        if (!inFinder && seed % 5 < 2) {
          paths.push({ d: [["M", c, r], ["L", c + 1, r], ["L", c + 1, r + 1], ["L", c, r + 1]] });
        }
      }
    }
    shapes.push(
      s.card("Code Card", 8.35, 1.95, 4.15, 4.15, { radius: 0.3 }),
      s.shape({
        name: "Code",
        x: 8.8,
        y: 2.4,
        w: 3.25,
        h: 3.25,
        geom: s.cust(N, N, paths),
        fill: C.ink,
        descr: "An illustration of a QR code",
      }),
    );
    out.push([1, shapes]);
  }

  {
    const s = builder();
    const rows = [
      ["Choose the files you want to show.", "Tick them in your list on your phone."],
      ["Tap Approve.", "Nothing is typed on the room PC."],
      ["The screen gets one link for each file.", "Each link is short-lived. It gets nothing else."],
    ];
    const shapes = [s.title("Approve on Your Phone")];
    rows.forEach(([head, line], i) => {
      const y = 1.95 + i * 1.3;
      shapes.push(
        s.shape({ name: `Dot ${i + 1}`, x: 0.85, y: y + 0.09, w: 0.2, h: 0.2, geom: "ellipse", fill: C.ink }),
        s.textBox(`Row ${i + 1}`, 1.4, y - 0.06, 6.3, 1.1, [
          s.para([{ t: head, sz: 22, b: true }]),
          s.para([{ t: line, sz: 18, color: C.muted }], { before: 3 }),
        ]),
      );
    });
    // The phone: a screen with two ticked files, one not ticked, and the Approve button.
    const [px, py] = [8.95, 1.75];
    shapes.push(
      s.shape({ name: "Phone", x: px, y: py, w: 3.4, h: 4.8, geom: "roundRect", radius: 0.45, fill: C.ink }),
      s.shape({ name: "Phone Screen", x: px + 0.12, y: py + 0.12, w: 3.16, h: 4.56, geom: "roundRect", radius: 0.35, fill: C.paper }),
      s.textBox("Phone Title", px + 0.4, py + 0.4, 2.6, 0.45, [s.para([{ t: "Choose Your Files", sz: 16, b: true }])]),
    );
    [
      ["Lecture.pptx", "PowerPoint", true],
      ["Handout.pdf", "PDF", true],
      ["Photo.jpg", "JPEG", false],
    ].forEach(([name, kind, ticked], i) => {
      const y = py + 1.0 + i * 0.78;
      shapes.push(
        s.shape({ name: `File ${i + 1}`, x: px + 0.3, y, w: 2.8, h: 0.66, geom: "roundRect", radius: 0.16, fill: C.white, line: { color: C.hairline, pt: 0.75 } }),
        s.textBox(`File ${i + 1} Name`, px + 0.45, y + 0.06, 1.9, 0.56, [
          s.para([{ t: name, sz: 14, b: true }]),
          s.para([{ t: kind, sz: 11, color: C.muted }]),
        ]),
        ticked
          ? s.badge("tick", px + 2.55, y + 0.15, 0.36, C.ink, C.white)
          : s.shape({ name: "Empty tick", x: px + 2.55, y: y + 0.15, w: 0.36, h: 0.36, geom: "ellipse", line: { color: "A3A39C", pt: 1.5 } }),
      );
    });
    shapes.push(
      s.shape({
        name: "Approve Button",
        x: px + 0.3,
        y: py + 3.55,
        w: 2.8,
        h: 0.62,
        geom: "roundRect",
        radius: 0.31,
        fill: C.ink,
        anchor: "ctr",
        text: [s.para([{ t: "Approve", sz: 17, b: true, color: C.white }], { algn: "ctr" })],
      }),
    );
    out.push([1, shapes]);
  }

  {
    const s = builder();
    const files = [
      ["Lecture.pptx", "PPTX", false],
      ["Handout.pdf", "PDF", true],
      ["Photo.jpg", "JPG", false],
    ];
    const shapes = [s.title("Move Between Files"), s.lead("Your phone is the remote. The screen follows.")];
    files.forEach(([name, kind, active], i) => {
      const x = 0.8 + i * 4.01;
      shapes.push(
        s.card(`File ${i + 1}`, x, 2.2, 3.71, 1.3, { line: active ? { color: C.ink, pt: 2.25 } : { color: C.hairline, pt: 0.75 } }),
        s.shape({
          name: `Type ${i + 1}`,
          x: x + 0.3,
          y: 2.55,
          w: 0.95,
          h: 0.6,
          geom: "roundRect",
          radius: 0.14,
          fill: C.g1,
          anchor: "ctr",
          text: [s.para([{ t: kind, sz: 15, b: true, color: C.ink2 }], { algn: "ctr" })],
        }),
        s.textBox(`File ${i + 1} Name`, x + 1.45, 2.55, 2.1, 0.6, [s.para([{ t: name, sz: 20, b: true }])], "ctr"),
      );
    });
    const cols = [
      ["Switch Files", "Tap another file in your list on your phone. The screen changes with it."],
      ["Move Through Slides", "Use Next and Previous on your phone or at the screen."],
      ["Use Your Clicker", "Arrow keys, Page Up and Page Down work at the screen. So does a presentation clicker."],
    ];
    cols.forEach(([head, line], i) => {
      const x = 0.8 + i * 4.01;
      shapes.push(
        s.textBox(`Column ${i + 1}`, x + 0.1, 4.0, 3.5, 2.2, [
          s.para([{ t: head, sz: 24, b: true }]),
          s.para([{ t: line, sz: 18, color: C.muted }], { before: 6 }),
        ]),
      );
    });
    out.push([1, shapes]);
  }

  {
    const s = builder();
    const ways = [
      ["Revoke on Your Phone", "Tap Revoke. The screen loses access at once."],
      ["End at the Screen", "Tap End. Every link stops working."],
      ["Let It Time Out", "It ends by itself, even if you forget."],
    ];
    const shapes = [s.title("End the Session")];
    ways.forEach(([head, line], i) => {
      const x = 0.8 + i * 4.01;
      shapes.push(
        s.card(`Way ${i + 1}`, x, 1.75, 3.71, 1.65),
        s.textBox(`Way ${i + 1} Text`, x + 0.3, 2.0, 3.15, 1.3, [
          s.para([{ t: head, sz: 22, b: true }]),
          s.para([{ t: line, sz: 17, color: C.muted }], { before: 6 }),
        ]),
      );
    });
    // Session length as a bar: 12 hours is the limit, 1 hour is where every session starts.
    const [bx, by, bw] = [0.8, 4.65, 11.73];
    shapes.push(
      s.textBox("Length Title", bx, 3.9, 6, 0.45, [s.para([{ t: "Session Length", sz: 20, b: true }])]),
      s.shape({ name: "Track", x: bx, y: by, w: bw, h: 0.24, geom: "roundRect", radius: 0.12, fill: C.g1 }),
      s.shape({ name: "Default Length", x: bx, y: by, w: bw / 12, h: 0.24, geom: "roundRect", radius: 0.12, fill: C.ink }),
      s.textBox("Default Label", bx, by + 0.35, 4, 0.45, [s.para([{ t: "1 Hour to Start", sz: 17, b: true, color: C.ink2 }])]),
      s.textBox("Limit Label", bx + bw - 4, by + 0.35, 4, 0.45, [s.para([{ t: "12 Hours at Most", sz: 17, b: true, color: C.ink2 }], { algn: "r" })]),
      s.textBox("Change Note", bx, by + 0.85, bw, 0.5, [
        s.para([{ t: "Change it any time on your phone. When it ends, every link stops working.", sz: 18, color: C.muted }]),
      ]),
    );
    out.push([1, shapes]);
  }

  {
    const s = builder();
    const gets = ["The files you approve", "One short-lived link for each file", "Access until the session ends"];
    const never = ["Your account", "Your other files", "A way to list your files", "The power to approve anything"];
    const column = (head, x, items, kind) => {
      const fill = kind === "tick" ? C.ink : C.rose;
      const ink = kind === "tick" ? C.white : C.roseInk;
      const shapes = [
        s.card(`${head} Card`, x, 1.95, 5.715, 3.85),
        s.textBox(`${head} Title`, x + 0.4, 2.2, 5.1, 0.6, [s.para([{ t: head, sz: 26, b: true }])], "ctr"),
      ];
      items.forEach((t, i) => {
        const y = 3.0 + i * 0.66;
        shapes.push(
          s.badge(kind, x + 0.4, y + 0.05, 0.42, fill, ink),
          s.textBox(`${head} ${i + 1}`, x + 1.05, y, 4.6, 0.52, [s.para([{ t, sz: 19, color: C.ink2 }])], "ctr"),
        );
      });
      return shapes;
    };
    out.push([
      1,
      [
        s.title("What the Screen Never Gets"),
        ...column("The Screen Gets", 0.8, gets, "tick"),
        ...column("The Screen Never Gets", 6.815, never, "cross"),
        s.textBox("Close", 0.8, 6.05, 11.73, 0.5, [
          s.para([{ t: "This sample is yours to delete. Add your own files and show them the same way.", sz: 18, color: C.ink2 }]),
        ]),
      ],
    ]);
  }
  return out;
}

const THEME = `${XML}<a:theme xmlns:a="${NS_A}" name="bloop"><a:themeElements><a:clrScheme name="bloop"><a:dk1>${color(C.ink)}</a:dk1><a:lt1>${color(C.white)}</a:lt1><a:dk2>${color(C.ink2)}</a:dk2><a:lt2>${color(C.paper)}</a:lt2><a:accent1>${color(C.ink)}</a:accent1><a:accent2>${color(C.robin)}</a:accent2><a:accent3>${color("A64F15")}</a:accent3><a:accent4>${color(C.muted)}</a:accent4><a:accent5>${color(C.g1)}</a:accent5><a:accent6>${color("CCE8DF")}</a:accent6><a:hlink>${color("A64F15")}</a:hlink><a:folHlink>${color(C.muted)}</a:folHlink></a:clrScheme><a:fontScheme name="bloop"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="bloop"><a:fillStyleLst>${solid(C.white)}${solid(C.white)}${solid(C.white)}</a:fillStyleLst><a:lnStyleLst>${stroke(C.ink, 0.75)}${stroke(C.ink, 1.5)}${stroke(C.ink, 2.25)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid(C.white)}${solid(C.white)}${solid(C.white)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const titleStyle = (sz) =>
  `<a:lvl1pPr algn="l"><a:defRPr sz="${sz * 100}" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${FONT}"/></a:defRPr></a:lvl1pPr>`;
const ph = (id, name, type, x, y, w, h, anchor) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${E(x)}" y="${E(y)}"/><a:ext cx="${E(w)}" cy="${E(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>`;
const emptyGroup = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

function master() {
  const s = builder();
  const footer = [
    s.logo(0.8, 6.82, 0.3),
    s.textBox("Wordmark", 1.2, 6.78, 2, 0.4, [s.para([{ t: "bloop", sz: 14, b: true, color: C.ink2 }])], "ctr"),
  ].join("");
  return `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr>${solid(C.paper)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyGroup}${ph(2, "Title Placeholder 1", "title", 0.8, 0.55, 11.73, 0.95, "ctr")}${footer}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${titleStyle(40)}</p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${FONT}"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

const layout = (name, type, showMaster, body) =>
  `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="${type}" preserve="1"${showMaster ? "" : ' showMasterSp="0"'}><p:cSld name="${name}"><p:spTree>${emptyGroup}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function parts(deck) {
  const override = (path, type) =>
    `<Override PartName="${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
  return [
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override("/ppt/presentation.xml", "presentationml.presentation.main")}${override("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster")}${override("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout")}${override("/ppt/slideLayouts/slideLayout2.xml", "presentationml.slideLayout")}${override("/ppt/theme/theme1.xml", "theme")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${override("/docProps/app.xml", "extended-properties")}${deck.map((_, i) => override(`/ppt/slides/slide${i + 1}.xml`, "presentationml.slide")).join("")}</Types>`,
    ],
    [
      "_rels/.rels",
      `${XML}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ],
    [
      "docProps/core.xml",
      `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Welcome to bloop</dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>`,
    ],
    [
      "docProps/app.xml",
      `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>bloop</Application><Slides>${deck.length}</Slides></Properties>`,
    ],
    [
      "ppt/presentation.xml",
      `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${deck.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ...deck.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`]),
        [`rId${deck.length + 2}`, "theme", "theme/theme1.xml"],
      ]),
    ],
    ["ppt/slideMasters/slideMaster1.xml", master()],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"],
        ["rId3", "theme", "../theme/theme1.xml"],
      ]),
    ],
    ["ppt/slideLayouts/slideLayout1.xml", layout("Title Only", "titleOnly", true, '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>')],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])],
    [
      "ppt/slideLayouts/slideLayout2.xml",
      layout("Title", "title", false, `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${E(0.8)}" y="${E(2.55)}"/><a:ext cx="${E(8.2)}" cy="${E(1.3)}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="6600" b="1"/></a:lvl1pPr></a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>`),
    ],
    ["ppt/slideLayouts/_rels/slideLayout2.xml.rels", rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])],
    ["ppt/theme/theme1.xml", THEME],
    ...deck.flatMap(([lay, shapes], i) => [
      [`ppt/slides/slide${i + 1}.xml`, slideXml(shapes, lay)],
      [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([["rId1", "slideLayout", `../slideLayouts/slideLayout${lay}.xml`]])],
    ]),
  ];
}

function soffice() {
  for (const path of ["/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice", "soffice"]) {
    if (path === "soffice" || existsSync(path)) return path;
  }
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const deck = slides();
  const pptx = zip(parts(deck));
  writeFileSync(`${OUT}demo-deck.pptx`, pptx);
  console.log(`demo-deck.pptx: ${pptx.length} bytes, ${deck.length} slides`);
  const tmp = mkdtempSync(join(tmpdir(), "demo-deck-"));
  try {
    execFileSync(soffice(), [`-env:UserInstallation=file://${tmp}/profile`, "--headless", "--convert-to", "pdf", "--outdir", tmp, `${OUT}demo-deck.pptx`], { stdio: "pipe" });
    renameSync(join(tmp, "demo-deck.pdf"), `${OUT}demo-handout.pdf`);
    console.log(`demo-handout.pdf: ${readFileSync(`${OUT}demo-handout.pdf`).length} bytes`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
