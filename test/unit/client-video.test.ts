import { describe, expect, it } from "vitest";
import { blankLocation, stripLocation } from "../../public/js/core/video.js";

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
/** A box: size, a four-character type, the body. */
const box = (type: string, ...body: (Uint8Array | number[])[]) => {
  const inner = cat(...body);
  return cat(u32(8 + inner.length), enc(type), inner);
};
/** A 64-bit-size box, as an iPhone writes a large mdat. */
const bigBox = (type: string, inner: Uint8Array) => cat(u32(1), enc(type), u32(0), u32(16 + inner.length), inner);

const ISO6709 = "+51.5074-000.1278+012.345/";
const MAKE = "Apple-make-value";
const key = (name: string) => cat(u32(8 + name.length), enc("mdta"), enc(name));
const item = (index: number, value: string) =>
  box(String.fromCharCode(...u32(index)), box("data", u32(1), u32(0), enc(value)));
const xyz = (text: string) => box("©xyz", [0, text.length, 0x15, 0xc7], enc(text));

/** An iPhone moov: meta with keys and ilst (QuickTime form, or with ISO version bytes), then udta/©xyz. */
function iphoneMoov(opts: { isoMeta?: boolean; keysAfter?: boolean } = {}) {
  const hdlr = box("hdlr", u32(0), u32(0), enc("mdta"), new Array(13).fill(0));
  const keys = box(
    "keys",
    u32(0),
    u32(3),
    key("com.apple.quicktime.make"),
    key("com.apple.quicktime.location.ISO6709"),
    key("com.apple.quicktime.software"),
  );
  const ilst = box("ilst", item(1, MAKE), item(2, ISO6709), item(3, "17.1"));
  const inner = opts.keysAfter ? [hdlr, ilst, keys] : [hdlr, keys, ilst];
  const meta = box("meta", opts.isoMeta ? u32(0) : [], ...inner);
  return box("moov", box("mvhd", new Array(20).fill(5)), meta, box("udta", xyz(ISO6709)));
}
const androidMoov = () => box("moov", box("mvhd", new Array(20).fill(5)), box("udta", xyz("+37.3861-122.0839/")));
const mdat = () => bigBox("mdat", enc("frame-bytes-and-the-string-+51.5074 are-media-not-metadata"));

const mov = (moov: Uint8Array) => cat(box("ftyp", enc("qt  "), u32(0), enc("qt  ")), box("wide"), mdat(), moov);
const mp4 = (moov: Uint8Array) => cat(box("ftyp", enc("isom"), u32(512), enc("isom")), moov, mdat());

const fileOf = (bytes: Uint8Array<ArrayBuffer>, name: string) => new File([bytes], name, { type: "video/quicktime" });
const read = async (f: Blob) => new Uint8Array(await f.arrayBuffer());
const find = (hay: Uint8Array, needle: string) => String.fromCharCode(...hay).includes(needle);
const diffAt = (a: Uint8Array, b: Uint8Array) => [...a.keys()].filter((i) => a[i] !== b[i]);

describe("VID-04 location strip", () => {
  it.each([
    ["an iPhone .mov (QuickTime meta)", () => mov(iphoneMoov()), ["+51.5074-000.1278"]],
    [
      "an iPhone .mov (ISO meta, keys after ilst)",
      () => mov(iphoneMoov({ isoMeta: true, keysAfter: true })),
      ["+51.5074-000.1278"],
    ],
    ["an Android .mp4 (moov first)", () => mp4(androidMoov()), ["+37.3861-122.0839"]],
  ])("blanks the location in %s and changes no other byte", async (_, build, secrets) => {
    const before = build() as Uint8Array<ArrayBuffer>;
    for (const s of secrets) expect(find(before, s)).toBe(true);
    const out = await stripLocation(fileOf(before, "clip.mov"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = await read(out.file);
    expect(after.length).toBe(before.length);
    for (const s of secrets) expect(find(after, s)).toBe(false);
    // Only the location values moved: every other byte, offsets included, is as it was.
    const changed = diffAt(before, after);
    expect(changed.length).toBeGreaterThan(0);
    for (const i of changed) expect(after[i]).toBe(0);
    expect(out.file.name).toBe("clip.mov");
    expect(find(after, MAKE)).toBe(find(before, MAKE));
    expect(find(after, "frame-bytes-and-the-string-+51.5074")).toBe(true);
  });

  it("keeps the other metadata values of an iPhone file", async () => {
    const before = mov(iphoneMoov()) as Uint8Array<ArrayBuffer>;
    const out = await stripLocation(fileOf(before, "a.mov"));
    expect(out.ok && find(await read(out.file), MAKE)).toBe(true);
  });

  it("blankLocation counts the iPhone's two places and the Android one", () => {
    expect(blankLocation(iphoneMoov())).toBe(2);
    expect(blankLocation(androidMoov())).toBe(1);
  });

  it("sends a file with no location as it is", async () => {
    const plain = mp4(box("moov", box("mvhd", new Array(20).fill(5)))) as Uint8Array<ArrayBuffer>;
    const f = fileOf(plain, "a.mp4");
    const out = await stripLocation(f);
    expect(out).toEqual({ ok: true, file: f });
  });

  it("walks a udta that ends with QuickTime's 4-byte zero terminator", async () => {
    const moov = box("moov", box("mvhd", new Array(20).fill(5)), box("udta", xyz(ISO6709), u32(0)));
    const before = mov(moov) as Uint8Array<ArrayBuffer>;
    const out = await stripLocation(fileOf(before, "old.mov"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = await read(out.file);
    expect(after.length).toBe(before.length);
    expect(find(after, "+51.5074-000.1278")).toBe(false);
  });

  it("still refuses a nonzero 4-byte tail in udta, and a zero tail outside udta", () => {
    expect(() => blankLocation(box("moov", box("udta", xyz(ISO6709), [0, 0, 0, 1])))).toThrow();
    expect(() => blankLocation(box("moov", box("mvhd", new Array(20).fill(5)), u32(0)))).toThrow();
  });

  it("blanks every location key, not only ISO6709", () => {
    const hdlr = box("hdlr", u32(0), u32(0), enc("mdta"), new Array(13).fill(0));
    const keys = box(
      "keys",
      u32(0),
      u32(2),
      key("com.apple.quicktime.location.ISO6709"),
      key("com.apple.quicktime.location.name"),
    );
    const moov = box("moov", box("meta", hdlr, keys, box("ilst", item(1, ISO6709), item(2, "Home Street"))));
    expect(blankLocation(moov)).toBe(2);
    expect(find(moov, "Home Street")).toBe(false);
  });

  const refused: [string, () => Uint8Array][] = [
    ["no moov", () => cat(box("ftyp", enc("isom"), u32(0), enc("isom")), mdat())],
    ["a box larger than its parent", () => mp4(box("moov", cat(u32(9999), enc("meta"), [0, 0, 0, 0])))],
    ["a box smaller than its header", () => mp4(box("moov", cat(u32(4), enc("udta"), [0, 0, 0, 0])))],
    ["a meta with no hdlr to find its children by", () => mp4(box("moov", box("meta", new Array(20).fill(9))))],
    [
      "a keys table that runs past its box",
      () => {
        const hdlr = box("hdlr", u32(0), u32(0), enc("mdta"), new Array(13).fill(0));
        return mp4(box("moov", box("meta", hdlr, box("keys", u32(0), u32(5), key("a.b")), box("ilst"))));
      },
    ],
    [
      "a location data box too short to hold a value",
      () => {
        const hdlr = box("hdlr", u32(0), u32(0), enc("mdta"), new Array(13).fill(0));
        const keys = box("keys", u32(0), u32(1), key("com.apple.quicktime.location.ISO6709"));
        const bad = box(String.fromCharCode(...u32(1)), box("data", [1, 2]));
        return mp4(box("moov", box("meta", hdlr, keys, box("ilst", bad))));
      },
    ],
    ["a file that is not a video", () => enc("%PDF-1.7 not a video at all, nothing to walk")],
    ["an empty file", () => new Uint8Array(0)],
    ["a 64-bit box too large to read", () => cat(u32(1), enc("moov"), u32(1), u32(0))],
    ["a truncated header", () => cat(box("ftyp", enc("isom"), u32(0), enc("isom")), [0, 0, 0])],
  ];
  it.each(refused)("refuses %s", async (_, build) => {
    expect(await stripLocation(fileOf(build() as Uint8Array<ArrayBuffer>, "a.mp4"))).toEqual({ ok: false });
  });

  it("refuses a moov over 32 MB without reading it", async () => {
    const head = cat(box("ftyp", enc("isom"), u32(0), enc("isom")), u32(40 * 1024 * 1024), enc("moov"));
    const f = new File([head], "a.mp4");
    Object.defineProperty(f, "size", { value: 40 * 1024 * 1024 + head.length });
    expect(await stripLocation(f)).toEqual({ ok: false });
  });
});

describe("VID-04 location strip, every placement", () => {
  const hdlr = () => box("hdlr", u32(0), u32(0), enc("mdta"), new Array(13).fill(0));
  const mvhd = () => box("mvhd", new Array(20).fill(5));
  const keysMeta = () =>
    box(
      "meta",
      u32(0),
      hdlr(),
      box("keys", u32(0), u32(1), key("com.apple.quicktime.location.ISO6709")),
      box("ilst", item(1, ISO6709)),
    );
  const loci = () => box("loci", u32(0), [0x15, 0xc7, 0], enc("Home Street 42"), enc("+51.5074-000.1278"));
  const keylessMeta = (inner: Uint8Array) => box("meta", u32(0), hdlr(), box("ilst", inner));
  const trak = (...kids: Uint8Array[]) => box("trak", box("tkhd", new Array(20).fill(1)), ...kids);

  const placements: [string, () => Uint8Array, string][] = [
    ["moov/udta/meta keys", () => box("moov", mvhd(), box("udta", keysMeta())), "+51.5074-000.1278"],
    [
      "an ilst ©xyz with no keys box",
      () => box("moov", mvhd(), box("udta", keylessMeta(box("©xyz", box("data", u32(1), u32(0), enc(ISO6709)))))),
      "+51.5074-000.1278",
    ],
    ["moov/udta/loci", () => box("moov", mvhd(), box("udta", loci())), "Home Street 42"],
    ["trak/udta/©xyz", () => box("moov", mvhd(), trak(box("udta", xyz(ISO6709)))), "+51.5074-000.1278"],
    ["trak/meta", () => box("moov", mvhd(), trak(keysMeta())), "+51.5074-000.1278"],
    [
      "trak/mdia/minf/udta/©xyz",
      () => box("moov", mvhd(), trak(box("mdia", box("minf", box("udta", xyz(ISO6709)))))),
      "+51.5074-000.1278",
    ],
  ];

  it.each(placements)("VID-04 location strip blanks %s", async (_, build, secret) => {
    const before = mp4(build()) as Uint8Array<ArrayBuffer>;
    expect(find(before, secret)).toBe(true);
    const out = await stripLocation(fileOf(before, "a.mp4"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = await read(out.file);
    expect(after.length).toBe(before.length);
    expect(find(after, secret)).toBe(false);
    const changed = diffAt(before, after);
    expect(changed.length).toBeGreaterThan(0);
    for (const i of changed) expect(after[i]).toBe(0);
  });

  it("VID-04 location strip keeps a non-location key and a keyless non-location item", () => {
    const keys = box("keys", u32(0), u32(1), key("com.apple.quicktime.make"));
    const moov = box(
      "moov",
      box("meta", hdlr(), keys, box("ilst", item(1, MAKE))),
      box("udta", keylessMeta(item(1, MAKE))),
    );
    expect(blankLocation(moov)).toBe(0);
    expect(find(moov, MAKE)).toBe(true);
  });

  it("VID-04 location strip returns a file with no location unchanged and OK", async () => {
    const plain = mp4(box("moov", mvhd(), trak(box("udta", box("name", enc("clip")))))) as Uint8Array<ArrayBuffer>;
    const f = fileOf(plain, "a.mp4");
    expect(await stripLocation(f)).toEqual({ ok: true, file: f });
  });

  const timedTrack = (entry: Uint8Array) =>
    trak(box("mdia", box("minf", box("stbl", box("stsd", u32(0), u32(1), entry)))));
  /** A `mebx` sample entry: its reserved bytes and data reference, then a keys box naming one key. */
  const mebx = (name: string) =>
    box("mebx", new Array(6).fill(0), [0, 1], box("keys", box("keyd", enc("mdta"), enc(name))));
  const refusedFile = async (moov: Uint8Array) =>
    expect(await stripLocation(fileOf(mp4(moov) as Uint8Array<ArrayBuffer>, "a.mp4"))).toEqual({ ok: false });

  it("VID-04 location strip refuses a GoPro gpmd track and a mebx track keyed for location", async () => {
    await refusedFile(box("moov", mvhd(), timedTrack(box("gpmd", new Array(8).fill(0)))));
    await refusedFile(box("moov", mvhd(), timedTrack(mebx("com.apple.quicktime.location.ISO6709"))));
  });

  it("VID-04 location strip accepts a mebx track with no location key, and an ordinary sample entry", async () => {
    for (const entry of [mebx("com.apple.quicktime.detected-face"), box("avc1", new Array(8).fill(0))]) {
      const f = fileOf(mp4(box("moov", mvhd(), timedTrack(entry))) as Uint8Array<ArrayBuffer>, "a.mp4");
      expect(await stripLocation(f)).toEqual({ ok: true, file: f });
    }
  });

  it("VID-04 location strip skips a nested meta with no ilst or keys, and still refuses one directly in moov", async () => {
    const stray = box("meta", new Array(20).fill(9));
    const f = fileOf(mp4(box("moov", mvhd(), trak(stray))) as Uint8Array<ArrayBuffer>, "a.mp4");
    expect(await stripLocation(f)).toEqual({ ok: true, file: f });
    await refusedFile(box("moov", mvhd(), stray));
  });

  it("VID-04 location strip refuses a nested meta with no hdlr that holds an ilst or keys, in either meta form", async () => {
    const tags = [box("ilst", item(1, ISO6709)), box("keys", u32(0), u32(0))];
    for (const inner of tags) {
      await refusedFile(box("moov", mvhd(), trak(box("meta", u32(0), inner))));
      await refusedFile(box("moov", mvhd(), trak(box("meta", inner))));
    }
  });

  it.each(["mett", "metx", "camm", "rtmd"])("VID-04 location strip refuses a %s timed-metadata track", async (type) => {
    await refusedFile(box("moov", mvhd(), timedTrack(box(type, new Array(8).fill(0)))));
  });

  it("VID-04 location strip refuses any entry in a track whose handler is meta, but accepts a clean mebx there", async () => {
    const metaTrackOf = (entry: Uint8Array) =>
      trak(
        box(
          "mdia",
          box("hdlr", u32(0), u32(0), enc("meta"), new Array(13).fill(0)),
          box("minf", box("stbl", box("stsd", u32(0), u32(1), entry))),
        ),
      );
    await refusedFile(box("moov", mvhd(), metaTrackOf(box("zzzz", new Array(8).fill(0)))));
    await refusedFile(box("moov", mvhd(), metaTrackOf(mebx("com.apple.quicktime.location.ISO6709"))));
    const f = fileOf(
      mp4(box("moov", mvhd(), metaTrackOf(mebx("com.apple.quicktime.detected-face")))) as Uint8Array<ArrayBuffer>,
      "a.mp4",
    );
    expect(await stripLocation(f)).toEqual({ ok: true, file: f });
  });

  it.each(["sbtl", "text", "subt"])("VID-04 location strip refuses a track whose handler is %s", async (handler) => {
    const track = trak(
      box(
        "mdia",
        box("hdlr", u32(0), u32(0), enc(handler), new Array(13).fill(0)),
        box("minf", box("stbl", box("stsd", u32(0), u32(1), box("tx3g", new Array(8).fill(0))))),
      ),
    );
    await refusedFile(box("moov", mvhd(), track));
  });

  it("VID-04 location strip refuses a `gps ` box in moov and an `XMP_` box in udta", async () => {
    await refusedFile(box("moov", mvhd(), box("gps ", new Array(16).fill(1))));
    await refusedFile(box("moov", mvhd(), box("udta", box("XMP_", enc("<x:xmpmeta/>")))));
    await refusedFile(box("moov", mvhd(), trak(box("udta", box("XMP_", enc("<x:xmpmeta/>"))))));
  });
});
