import { describe, expect, it } from "vitest";
import {
  buildSlidesJson,
  checkManifest,
  checkMeta,
  checkNotes,
  checkSlides,
  collect,
  decideGroups,
  expectedPaths,
  type Group,
  OutputError,
  packPlan,
  parsePath,
  pieceGuard,
  sha256Hex,
  storedPaths,
} from "../../src/worker/convert/outputs.ts";
import { PROFILES } from "../../src/worker/convert/profile.ts";
import { buildStubOutputs, stubJpeg, stubMp4, stubPdf, stubWebp } from "../../src/worker/convert/stub-outputs.ts";

const full = PROFILES.full;
const demo = PROFILES.demo;
const JOB = "f1_v1_a1";
const ORIGINAL = "b".repeat(64);
const enc = new TextEncoder();

const ctx = (ext = "pptx", profile = full) => ({ jobId: JOB, ext, profile });
const deck = (pages = 3, profile = full) => buildStubOutputs(JOB, "pptx", profile, ORIGINAL, { pages, notes: [2] });

/** Streams `bytes` in chunks of `step` through the guard declared with `declared`, and resolves with what came out. */
async function through(
  path: string,
  bytes: Uint8Array,
  declared?: { size?: number; sha256?: string },
  step = 7,
  pages?: { w: number; h: number }[],
) {
  const piece = { size: declared?.size ?? bytes.length, sha256: declared?.sha256 ?? (await sha256Hex(bytes)) };
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += step) c.enqueue(bytes.slice(i, i + step));
      c.close();
    },
  });
  return collect(source.pipeThrough(pieceGuard(path, piece, pages ? { pages } : {})), 10 * 1024 * 1024);
}
const refused = (p: Promise<unknown>, reason: string) =>
  expect(p).rejects.toMatchObject({ name: "Error", reason: expect.stringContaining(reason) });

describe("CONV-04 outputs: manifest", () => {
  it("accepts a real-shaped manifest and returns the checked pieces", async () => {
    const { manifest } = await deck();
    const r = checkManifest(manifest, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checked.rendered).toBe(3);
      expect(r.checked.pieces.size).toBe(manifest.files.length);
      expect([...r.checked.passed].sort()).toEqual(["notes", "pdf", "slides"]);
    }
  });

  it("refuses a jobId or kind that is not ours", async () => {
    const { manifest } = await deck();
    expect(checkManifest({ ...manifest, jobId: "other" }, ctx())).toEqual({ ok: false, reason: "job_id" });
    expect(checkManifest({ ...manifest, kind: "video" }, ctx())).toEqual({ ok: false, reason: "kind" });
    expect(checkManifest(manifest, ctx("mp4"))).toMatchObject({ ok: false });
  });

  it("refuses a duplicate path, an extra file, a missing page and an unknown key", async () => {
    const { manifest } = await deck();
    expect(
      checkManifest({ ...manifest, files: [...manifest.files, ...manifest.files.slice(0, 1)] }, ctx()),
    ).toMatchObject({ ok: false, reason: "duplicate_path" });
    const extra = { path: "evil.html", size: 1, sha256: "a".repeat(64), type: "text/html" };
    expect(checkManifest({ ...manifest, files: [...manifest.files, extra] }, ctx())).toMatchObject({
      ok: false,
      reason: "path_grammar",
    });
    const without = manifest.files.filter((f) => f.path !== "s/2/1920.webp");
    expect(checkManifest({ ...manifest, files: without }, ctx())).toMatchObject({ ok: false, reason: "path_set" });
    expect(checkManifest({ ...manifest, surprise: 1 }, ctx())).toMatchObject({ ok: false, reason: "manifest_shape" });
  });

  it.each([
    "s/0/1920.webp",
    "s/01/1920.webp",
    "S/1/1920.webp",
    "../x",
    "/doc.pdf",
    "s/1/1920.webp/",
    "dос.pdf",
    "m/0.mp4 ",
  ])("refuses the path %s", async (path) => {
    expect(parsePath(path)).toBeNull();
    const { manifest } = await deck();
    const bad = { path, size: 1, sha256: "a".repeat(64), type: "image/webp" };
    expect(checkManifest({ ...manifest, files: [...manifest.files, bad] }, ctx())).toMatchObject({ ok: false });
  });

  it("refuses a page past rendered and a width the profile does not render", async () => {
    const { manifest } = await deck(2, demo);
    const wide = { path: "s/1/3840.webp", size: 40, sha256: "a".repeat(64), type: "image/webp" };
    expect(checkManifest({ ...manifest, files: [...manifest.files, wide] }, ctx("pptx", demo))).toMatchObject({
      ok: false,
      reason: "path_range",
    });
    const past = { path: "s/3/1920.webp", size: 40, sha256: "a".repeat(64), type: "image/webp" };
    expect(checkManifest({ ...manifest, files: [...manifest.files, past] }, ctx("pptx", demo))).toMatchObject({
      ok: false,
      reason: "path_range",
    });
  });

  it("refuses a file over its cap and a total over the profile's", async () => {
    const { manifest } = await deck(2, demo);
    const swell = (path: string, size: number) => ({
      ...manifest,
      files: manifest.files.map((f) => (f.path === path ? { ...f, size } : f)),
    });
    expect(checkManifest(swell("s/1/1920.webp", 41 * 1024 * 1024), ctx("pptx", demo))).toMatchObject({
      reason: "file_cap",
    });
    expect(checkManifest(swell("doc.pdf", 201 * 1024 * 1024), ctx("pptx", demo))).toMatchObject({
      reason: "total_cap",
    });
  });

  it("ignores a container Content-Type: the type comes from the path", async () => {
    const { manifest } = await deck();
    const html = { ...manifest, files: manifest.files.map((f) => ({ ...f, type: "text/html" })) };
    expect(checkManifest(html, ctx()).ok).toBe(true);
  });

  it("refuses more files than 3 x rendered + 6", async () => {
    const { manifest } = await deck(1);
    const many = Array.from({ length: 12 }, (_, i) => ({
      path: `s/1/${i + 1}.webp`,
      size: 1,
      sha256: "a".repeat(64),
      type: "x",
    }));
    expect(checkManifest({ ...manifest, files: [...manifest.files, ...many] }, ctx())).toMatchObject({
      ok: false,
      reason: "too_many_files",
    });
  });

  it("demo truncation: rendered 40 with total 60 passes; over 40 or over total is refused", async () => {
    const { manifest } = await deck(40, demo);
    expect(checkManifest({ ...manifest, pages: { total: 60, rendered: 40 } }, ctx("pptx", demo)).ok).toBe(true);
    expect(checkManifest({ ...manifest, pages: { total: 60, rendered: 41 } }, ctx("pptx", demo))).toMatchObject({
      reason: "pages_range",
    });
    expect(checkManifest({ ...manifest, pages: { total: 39, rendered: 40 } }, ctx("pptx", demo))).toMatchObject({
      reason: "pages_range",
    });
  });

  it("a document needs pages and a video must not have them", async () => {
    const { manifest } = await deck();
    expect(checkManifest({ ...manifest, pages: null }, ctx())).toMatchObject({ reason: "pages_presence" });
    const v = await buildStubOutputs(JOB, "mp4", full, ORIGINAL, { pages: 0 });
    expect(checkManifest(v.manifest, ctx("mp4")).ok).toBe(true);
    expect(checkManifest({ ...v.manifest, pages: { total: 1, rendered: 1 } }, ctx("mp4"))).toMatchObject({
      reason: "pages_presence",
    });
  });

  it("a failed group is withheld: its files must be absent from the manifest", async () => {
    const { manifest } = await deck();
    const noPdf = {
      ...manifest,
      groups: { ...manifest.groups, pdf: { ok: false, error: "output_invalid" } },
      files: manifest.files.filter((f) => f.path !== "doc.pdf"),
    };
    const r = checkManifest(noPdf, ctx());
    expect(r.ok && [...r.checked.passed].sort()).toEqual(["notes", "slides"]);
    expect(checkManifest({ ...noPdf, files: manifest.files }, ctx())).toMatchObject({ reason: "path_set" });
  });

  it("expectedPaths lists every page at every width", () => {
    const set = expectedPaths(2, [1920, 480], new Set<Group>(["slides"]));
    expect([...set].sort()).toEqual([
      "meta.json",
      "s/1/1920.webp",
      "s/1/480.webp",
      "s/2/1920.webp",
      "s/2/480.webp",
      "slides.json",
      "t.webp",
    ]);
  });
});

describe("CONV-04 outputs: pieces", () => {
  const goodPage = stubWebp(1920, 1080, 1);
  const pages = [{ w: 3840, h: 2160 }];

  it("passes a good page and returns its bytes unchanged", async () => {
    expect(await through("s/1/1920.webp", goodPage, undefined, 7, pages)).toEqual(goodPage);
  });

  it("refuses a RIFF size off by one", async () => {
    const bad = goodPage.slice();
    new DataView(bad.buffer).setUint32(4, bad.length - 7, true);
    await refused(through("s/1/1920.webp", bad, undefined, 7, pages), "webp");
  });

  it("refuses a width that is not the path's and a height that does not match slides.json", async () => {
    await refused(through("s/1/1920.webp", stubWebp(1919, 1080), undefined, 7, pages), "webp_width");
    await refused(through("s/1/1920.webp", stubWebp(1920, 1000), undefined, 7, pages), "webp_height");
    expect(await through("s/1/1920.webp", stubWebp(1920, 1081), undefined, 7, pages)).toBeTruthy();
  });

  it("refuses a thumbnail wider than 480 and a page with no slides.json entry", async () => {
    await refused(through("t.webp", stubWebp(481, 270)), "thumb_width");
    await refused(through("s/2/1920.webp", goodPage, undefined, 7, pages), "webp_height");
  });

  it("refuses a RIFF that is not WebP", async () => {
    await refused(through("t.webp", enc.encode("RIFF____WAVEfmt  ".padEnd(40, "x"))), "webp");
  });

  it("refuses bytes longer and shorter than declared, and a sha mismatch at flush", async () => {
    await refused(through("doc.pdf", stubPdf(1), { size: stubPdf(1).length - 1 }), "longer_than_declared");
    await refused(through("doc.pdf", stubPdf(1), { size: stubPdf(1).length + 1 }), "shorter_than_declared");
    await refused(through("doc.pdf", stubPdf(1), { sha256: "c".repeat(64) }), "sha256");
  });

  it("refuses a PDF with /JavaScript split across chunk edges, at every cut", async () => {
    const body = enc.encode("%PDF-1.7\n1 0 obj << /S /JavaScript >> endobj\n%%EOF\n");
    for (let step = 2; step < 14; step++)
      await refused(through("doc.pdf", body, undefined, step), "pdf_active_content");
    await refused(through("doc.pdf", enc.encode("%PDF-1.7\n/Launch\n%%EOF"), undefined, 3), "pdf_active_content");
    await refused(through("doc.pdf", enc.encode("%PDF-1.7\n/EmbeddedFile\n%%EOF"), undefined, 5), "pdf_active_content");
  });

  it("refuses a PDF with no header or no trailer", async () => {
    await refused(through("doc.pdf", enc.encode("hello %%EOF")), "pdf_start");
    await refused(through("doc.pdf", enc.encode("%PDF-1.7\nno trailer")), "pdf_end");
  });

  it("checks a JPEG's markers and width", async () => {
    expect(await through("i/1920.jpg", stubJpeg(1920, 1080))).toBeTruthy();
    await refused(through("i/1920.jpg", stubJpeg(1921, 1080)), "jpeg_width");
    await refused(through("i/1920.jpg", stubJpeg(1920, 1080).slice(0, -2)), "jpeg_end");
    await refused(through("i/1920.jpg", enc.encode("not a jpeg at all, no")), "jpeg_start");
  });

  it("checks an mp4's ftyp brand", async () => {
    expect(await through("m/0.mp4", stubMp4())).toBeTruthy();
    const bad = stubMp4().slice();
    bad.set(enc.encode("ftyp"), 4);
    bad.set(enc.encode("qt  "), 8);
    await refused(through("m/0.mp4", bad), "mp4_ftyp");
    await refused(through("m/0.mp4", enc.encode("no ftyp box in these bytes")), "mp4_ftyp");
  });
});

describe("CONV-04 outputs: json", () => {
  const j = (v: unknown) => enc.encode(JSON.stringify(v));
  const slides = {
    v: 1,
    widths: [1920, 480],
    pages: [
      { n: 1, w: 1920, h: 1080 },
      { n: 2, w: 1920, h: 1080 },
    ],
    motion: false,
    media: false,
  };

  it("accepts a good slides.json and refuses a count, width list or page entry that is off", () => {
    expect(checkSlides(j(slides), { rendered: 2, profile: demo }).pages).toHaveLength(2);
    expect(() => checkSlides(j(slides), { rendered: 3, profile: demo })).toThrow(OutputError);
    expect(() => checkSlides(j({ ...slides, widths: [1920] }), { rendered: 2, profile: demo })).toThrow(OutputError);
    expect(() =>
      checkSlides(j({ ...slides, pages: [slides.pages[1], slides.pages[0]] }), { rendered: 2, profile: demo }),
    ).toThrow(OutputError);
    expect(() => checkSlides(j({ ...slides, extra: 1 }), { rendered: 2, profile: demo })).toThrow(OutputError);
    expect(() => checkSlides(enc.encode("{nope"), { rendered: 2, profile: demo })).toThrow(OutputError);
  });

  it("notes: an unknown field, 4001 characters, out of order, a control character", () => {
    const notes = (list: unknown[]) => j({ v: 1, notes: list });
    expect(
      checkNotes(
        notes([
          { n: 1, text: "a\nb" },
          { n: 3, text: "c" },
        ]),
        { rendered: 3 },
      ),
    ).toHaveLength(2);
    expect(() => checkNotes(notes([{ n: 1, text: "x", extra: 1 }]), { rendered: 3 })).toThrow(OutputError);
    expect(() => checkNotes(notes([{ n: 1, text: "x".repeat(4001) }]), { rendered: 3 })).toThrow(OutputError);
    expect(checkNotes(notes([{ n: 1, text: "x".repeat(4000) }]), { rendered: 3 })).toHaveLength(1);
    expect(() =>
      checkNotes(
        notes([
          { n: 2, text: "a" },
          { n: 1, text: "b" },
        ]),
        { rendered: 3 },
      ),
    ).toThrow(OutputError);
    expect(() =>
      checkNotes(
        notes([
          { n: 1, text: "a" },
          { n: 1, text: "b" },
        ]),
        { rendered: 3 },
      ),
    ).toThrow(OutputError);
    expect(() => checkNotes(notes([{ n: 4, text: "a" }]), { rendered: 3 })).toThrow(OutputError);
    expect(() => checkNotes(notes([{ n: 1, text: "a\u0007" }]), { rendered: 3 })).toThrow(OutputError);
  });

  it("meta: the kind must match, video and image carry their own block, font lists are bounded", () => {
    const base = { v: 1, sha256: ORIGINAL, kind: "deck", fontsMissing: ["Aptos"] };
    expect(checkMeta(j(base), { kind: "deck" }).fontsMissing).toEqual(["Aptos"]);
    expect(() => checkMeta(j(base), { kind: "doc" })).toThrow(OutputError);
    expect(() =>
      checkMeta(j({ ...base, fontsMissing: Array.from({ length: 51 }, () => "A") }), { kind: "deck" }),
    ).toThrow(OutputError);
    expect(() => checkMeta(j({ ...base, fontsMissing: ["x".repeat(101)] }), { kind: "deck" })).toThrow(OutputError);
    expect(() => checkMeta(j({ v: 1, sha256: ORIGINAL, kind: "video" }), { kind: "video" })).toThrow(OutputError);
    const video = { v: 1, sha256: ORIGINAL, kind: "video", video: { w: 9000, h: 720, durationMs: 1000 } };
    expect(() => checkMeta(j(video), { kind: "video" })).toThrow(OutputError);
    expect(() =>
      checkMeta(j({ ...video, video: { w: 1280, h: 720, durationMs: 5 * 3600 * 1000 } }), { kind: "video" }),
    ).toThrow(OutputError);
    expect(checkMeta(j({ ...video, video: { w: 1280, h: 720, durationMs: 1000 } }), { kind: "video" }).video?.w).toBe(
      1280,
    );
    expect(() =>
      checkMeta(j({ v: 1, sha256: ORIGINAL, kind: "image", image: { w: 20000, h: 20000 } }), { kind: "image" }),
    ).toThrow(OutputError);
  });
});

describe("CONV-04 packs", () => {
  it("offsets match the piece sizes and the pack size is their sum", async () => {
    const { manifest } = await deck(4);
    const r = checkManifest(manifest, ctx());
    if (!r.ok) throw new Error(r.reason);
    const plans = packPlan(4, full.widths, r.checked.pieces);
    expect(plans.map((p) => p.w)).toEqual([3840, 1920, 480]);
    for (const plan of plans) {
      let at = 0;
      for (const piece of plan.pieces) {
        expect(piece.start).toBe(at);
        expect(piece.length).toBe(r.checked.pieces.get(`s/${piece.n}/${plan.w}.webp`)?.size);
        at += piece.length;
      }
      expect(plan.size).toBe(at);
      expect(plan.pieces.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    }
  });

  it("the DO-built slides.json is v2, carries only checked values and parses strictly back", async () => {
    const out = await deck(2, demo);
    const r = checkManifest(out.manifest, ctx("pptx", demo));
    if (!r.ok) throw new Error(r.reason);
    const slides = checkSlides(out.files.get("slides.json") as Uint8Array, { rendered: 2, profile: demo });
    const plans = packPlan(2, demo.widths, r.checked.pieces);
    const built = buildSlidesJson(slides, { total: 9, rendered: 2 }, plans);
    expect(built).toMatchObject({
      v: 2,
      total: 9,
      rendered: 2,
      motion: false,
      packs: { "1920": { size: plans[0]?.size }, "480": { size: plans[1]?.size } },
    });
    expect(built.offsets["1920"]).toEqual(plans[0]?.pieces.map((p) => [p.start, p.length]));
    expect(Object.keys(built).sort()).toEqual([
      "media",
      "motion",
      "offsets",
      "packs",
      "pages",
      "rendered",
      "total",
      "v",
    ]);
  });

  it("a piece missing from the checked set is an error, not an empty slot", () => {
    expect(() => packPlan(2, [1920], new Map([["s/1/1920.webp", { size: 1, sha256: "a" }]]))).toThrow(OutputError);
  });

  it("a bad piece in the middle of a pack errors the whole stream", async () => {
    const pieces = [stubWebp(480, 270, 1), stubWebp(481, 270, 2), stubWebp(480, 270, 3)];
    const written: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({ write: (c) => void written.push(c) });
    const out = sink.getWriter();
    const pack = async () => {
      for (const [i, bytes] of pieces.entries()) {
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            c.enqueue(bytes);
            c.close();
          },
        });
        const checked = body.pipeThrough(
          pieceGuard(
            `s/${i + 1}/480.webp`,
            { size: bytes.length, sha256: await sha256Hex(bytes) },
            { pages: [1, 2, 3].map(() => ({ w: 480, h: 270 })) },
          ),
        );
        for await (const chunk of checked as unknown as AsyncIterable<Uint8Array>) await out.write(chunk);
      }
    };
    await expect(pack()).rejects.toMatchObject({ reason: "webp_width" });
    // The bad piece's own bytes passed before its flush failed: only the errored stream, which makes the put
    // reject, keeps a pack from existing (the integration test proves R2 stores nothing then).
    expect(written.length).toBeLessThanOrEqual(2);
  });
});

describe("CONV-04 outputs: groups", () => {
  const set = (...g: Group[]) => new Set<Group>(g);

  it("a bad page publishes the pdf only; a bad PDF publishes the slides; both bad is output_invalid", () => {
    expect(decideGroups("deck", set("pdf", "notes"))).toEqual({ ok: true, groups: ["pdf", "notes"] });
    expect(decideGroups("deck", set("slides", "notes"))).toEqual({ ok: true, groups: ["slides", "notes"] });
    expect(decideGroups("deck", set("notes"))).toEqual({ ok: false });
    expect(decideGroups("deck", set())).toEqual({ ok: false });
  });

  it("a failed media or image group is output_invalid", () => {
    expect(decideGroups("video", set())).toEqual({ ok: false });
    expect(decideGroups("video", set("media"))).toEqual({ ok: true, groups: ["media"] });
    expect(decideGroups("image", set())).toEqual({ ok: false });
  });

  it("bad notes still leave a done document without them", () => {
    expect(decideGroups("deck", set("slides", "pdf"))).toEqual({ ok: true, groups: ["slides", "pdf"] });
  });

  it("stored names per group: notes are not with the slides, the pack is", () => {
    expect(storedPaths("slides", [1920, 480])).toEqual([
      "t.webp",
      "s/1/1920.webp",
      "s/1/480.webp",
      "s/1920.pack",
      "s/480.pack",
      "slides.json",
    ]);
    expect(storedPaths("notes", [1920])).toEqual(["notes.json"]);
  });
});
