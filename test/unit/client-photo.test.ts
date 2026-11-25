import { describe, expect, it } from "vitest";
import { fitSize, LONG_SIDE, preparePhoto } from "../../public/js/core/photo.js";

const MB = 1024 * 1024;
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** SOI, an Exif APP1 holding a GPS tag, then the scan. */
const exifJpeg = (pad = 0) => {
  const app1 = [...text("Exif\0\0"), ...text("GPSLatitude=51.5"), ...new Array(pad).fill(0)];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xda, 0, 2, 1, 2, 3]);
};
/** SOI, a JFIF APP0, then the scan: what a canvas writes. */
const plainJpeg = (size = 10) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2, ...new Array(size).fill(7)]);
const file = (bytes: Uint8Array<ArrayBuffer>, name: string, type: string) => new File([bytes], name, { type });
const bytesOf = async (f: Blob) => new Uint8Array(await f.arrayBuffer());
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** A browser with no canvas: the decoded size, what each call was given, and the encoder's output. */
function fakeEnv(opts: {
  width: number;
  height: number;
  out?: Uint8Array<ArrayBuffer>;
  alpha?: boolean;
  decodeFails?: boolean;
}) {
  const calls = { decode: [] as object[], surfaces: [] as [number, number][], encoded: 0 };
  const env = {
    decode: async (_src: unknown, options: object) => {
      calls.decode.push(options);
      if (opts.decodeFails) throw new Error("undecodable");
      const o = options as { resizeWidth?: number; resizeHeight?: number };
      return o.resizeWidth
        ? { width: o.resizeWidth, height: o.resizeHeight as number }
        : { width: opts.width, height: opts.height };
    },
    surface: (width: number, height: number) => {
      calls.surfaces.push([width, height]);
      return {
        draw: () => {},
        hasAlpha: () => !!opts.alpha,
        encode: async (type: string) => {
          calls.encoded++;
          return new Blob([opts.out ?? plainJpeg()], { type });
        },
      };
    },
  };
  return { env, calls };
}

describe("fitSize", () => {
  it("caps the long side at 2560 and keeps the ratio, either way up", () => {
    expect(fitSize(5120, 3840)).toEqual({ width: 2560, height: 1920 });
    expect(fitSize(3840, 5120)).toEqual({ width: 1920, height: 2560 });
    expect(fitSize(12000, 9000)).toEqual({ width: 2560, height: 1920 });
  });

  it("keeps a smaller image's size, and never reaches zero", () => {
    expect(fitSize(2560, 1000)).toEqual({ width: 2560, height: 1000 });
    expect(fitSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitSize(100000, 1)).toEqual({ width: LONG_SIDE, height: 1 });
  });
});

/** The file a successful prepare sends; fails the test on a refusal. */
const sent = (out: Awaited<ReturnType<typeof preparePhoto>>) => {
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.file;
};

describe("preparePhoto", () => {
  it("caps the canvas at 2560 on the long side and never draws a full-size one", async () => {
    const { env, calls } = fakeEnv({ width: 12000, height: 9000 });
    sent(await preparePhoto(file(exifJpeg(100000), "big.jpg", "image/jpeg"), 90 * MB, env));
    expect(calls.surfaces).toEqual([[2560, 1920]]);
    expect(calls.decode[1]).toMatchObject({ resizeWidth: 2560, resizeHeight: 1920, resizeQuality: "high" });
  });

  it("decodes with the orientation applied and sizes the canvas from the upright bitmap", async () => {
    const { env, calls } = fakeEnv({ width: 3000, height: 4000 });
    await preparePhoto(file(exifJpeg(100000), "portrait.jpg", "image/jpeg"), 90 * MB, env);
    expect(calls.decode[0]).toEqual({ imageOrientation: "from-image" });
    expect(calls.surfaces).toEqual([[1920, 2560]]);
  });

  it("sends a re-encode with no Exif APP1 and none of the original's bytes", async () => {
    const { env } = fakeEnv({ width: 4000, height: 3000 });
    const out = sent(await preparePhoto(file(exifJpeg(100000), "IMG_1.JPG", "image/jpeg"), 90 * MB, env));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_1.jpg");
    const bytes = latin1(await bytesOf(out));
    expect(bytes).not.toContain("Exif");
    expect(bytes).not.toContain("GPS");
  });

  it("does not resize a small image", async () => {
    const { env, calls } = fakeEnv({ width: 800, height: 600 });
    await preparePhoto(file(exifJpeg(100000), "s.jpg", "image/jpeg"), 90 * MB, env);
    expect(calls.decode).toHaveLength(1);
    expect(calls.surfaces).toEqual([[800, 600]]);
  });

  it("draws a downscale itself when the browser ignores the resize options", async () => {
    const { env, calls } = fakeEnv({ width: 5000, height: 4000 });
    const ignoring = { ...env, decode: async () => ({ width: 5000, height: 4000 }) };
    await preparePhoto(file(exifJpeg(100000), "s.jpg", "image/jpeg"), 90 * MB, ignoring);
    expect(calls.surfaces).toEqual([[2560, 2048]]);
  });

  it("sends the re-encode even when the original is smaller and has no metadata (Privacy 3.4)", async () => {
    const original = plainJpeg(10);
    const reencoded = plainJpeg(500);
    const { env } = fakeEnv({ width: 100, height: 100, out: reencoded });
    const out = sent(await preparePhoto(file(original, "a.jpg", "image/jpeg"), 90 * MB, env));
    expect(await bytesOf(out)).toEqual(reencoded);
  });

  it("sends the re-encode when the original has Exif and the re-encode is larger", async () => {
    const reencoded = plainJpeg(5000);
    const { env } = fakeEnv({ width: 100, height: 100, out: reencoded });
    const out = sent(await preparePhoto(file(exifJpeg(), "a.jpg", "image/jpeg"), 90 * MB, env));
    expect(await bytesOf(out)).toEqual(reencoded);
  });

  it("re-encodes a PNG with transparency as a PNG, never the original's bytes (a PNG can carry Exif too)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, ...text("eXIfGPS")]);
    const { env, calls } = fakeEnv({ width: 400, height: 400, alpha: true, out: new Uint8Array([9, 9]) });
    const out = sent(await preparePhoto(file(png, "sticker.png", "image/png"), 90 * MB, env));
    expect(out.name).toBe("sticker.png");
    expect(out.type).toBe("image/png");
    expect(await bytesOf(out)).toEqual(new Uint8Array([9, 9]));
    expect(calls.encoded).toBe(1);
  });

  it("sends an opaque PNG as a JPEG named .jpg", async () => {
    const { env } = fakeEnv({ width: 400, height: 400 });
    const out = sent(await preparePhoto(file(new Uint8Array(5000), "shot.PNG", "image/png"), 90 * MB, env));
    expect(out.name).toBe("shot.jpg");
    expect(out.type).toBe("image/jpeg");
  });

  it("sends an opaque PNG as its JPEG even when that comes out larger", async () => {
    const { env } = fakeEnv({ width: 40, height: 40, out: plainJpeg(500) });
    const out = sent(await preparePhoto(file(new Uint8Array(20), "flat.png", "image/png"), 90 * MB, env));
    expect(out.name).toBe("flat.jpg");
  });

  it("refuses with decode when the browser cannot read it, however clean and small the original", async () => {
    const { env } = fakeEnv({ width: 1, height: 1, decodeFails: true });
    expect(await preparePhoto(file(plainJpeg(), "a.jpg", "image/jpeg"), MB, env)).toEqual({
      ok: false,
      reason: "decode",
    });
  });

  it("refuses with encode when the browser writes another type, or the canvas throws", async () => {
    const { env } = fakeEnv({ width: 10, height: 10 });
    const wrongType = {
      ...env,
      surface: (w: number, h: number) => ({
        ...env.surface(w, h),
        encode: async () => new Blob(["x"], { type: "image/png" }),
      }),
    };
    expect(await preparePhoto(file(plainJpeg(), "a.jpg", "image/jpeg"), MB, wrongType)).toEqual({
      ok: false,
      reason: "encode",
    });
    const closed: string[] = [];
    const throwing = {
      decode: async () => ({ width: 10, height: 10, close: () => closed.push("bitmap") }),
      surface: () => {
        throw new Error("no canvas");
      },
    };
    expect(await preparePhoto(file(plainJpeg(), "a.jpg", "image/jpeg"), MB, throwing)).toEqual({
      ok: false,
      reason: "encode",
    });
    expect(closed).toEqual(["bitmap"]);
  });

  it("converts a HEIC the browser decodes to a JPEG named .jpg", async () => {
    const { env, calls } = fakeEnv({ width: 4032, height: 3024 });
    const out = sent(await preparePhoto(file(new Uint8Array(3000), "IMG_1.HEIC", "image/heic"), 90 * MB, env));
    expect(out.name).toBe("IMG_1.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(calls.surfaces).toEqual([[2560, 1920]]);
  });

  it("never sends a HEIC as it is: not when decoding fails, nor when the JPEG comes out larger", async () => {
    const heic = file(new Uint8Array(20), "a.heic", "image/heic");
    const failed = await preparePhoto(heic, MB, fakeEnv({ width: 1, height: 1, decodeFails: true }).env);
    expect(failed).toEqual({ ok: false, reason: "decode" });
    const larger = sent(await preparePhoto(heic, MB, fakeEnv({ width: 40, height: 40, out: plainJpeg(500) }).env));
    expect(larger.name).toBe("a.jpg");
  });

  it("refuses with large when the re-encode is over the cap", async () => {
    const { env } = fakeEnv({ width: 100, height: 100, out: plainJpeg(500) });
    expect(await preparePhoto(file(exifJpeg(100000), "a.jpg", "image/jpeg"), 100, env)).toEqual({
      ok: false,
      reason: "large",
    });
  });
});
