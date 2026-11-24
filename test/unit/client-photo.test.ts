import { describe, expect, it } from "vitest";
import { fitSize, hasExif, LONG_SIDE, preparePhoto } from "../../public/js/core/photo.js";

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
        encode: async () => {
          calls.encoded++;
          return new Blob([opts.out ?? plainJpeg()], { type: "image/jpeg" });
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

describe("hasExif", () => {
  it("finds an Exif APP1 before the scan, and not a JFIF one", async () => {
    expect(await hasExif(file(exifJpeg(), "a.jpg", "image/jpeg"))).toBe(true);
    expect(await hasExif(file(plainJpeg(), "a.jpg", "image/jpeg"))).toBe(false);
  });
});

describe("preparePhoto", () => {
  it("caps the canvas at 2560 on the long side and never draws a full-size one", async () => {
    const { env, calls } = fakeEnv({ width: 12000, height: 9000 });
    const out = await preparePhoto(file(exifJpeg(100000), "big.jpg", "image/jpeg"), 90 * MB, env);
    expect(out).not.toBeNull();
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
    const original = exifJpeg(100000);
    const { env } = fakeEnv({ width: 4000, height: 3000 });
    const out = await preparePhoto(file(original, "IMG_1.JPG", "image/jpeg"), 90 * MB, env);
    expect(out?.type).toBe("image/jpeg");
    expect(out?.name).toBe("IMG_1.jpg");
    const sent = latin1(await bytesOf(out as File));
    expect(sent).not.toContain("Exif");
    expect(sent).not.toContain("GPS");
    expect(await hasExif(out as File)).toBe(false);
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

  it("keeps an original JPEG without Exif when the re-encode comes out larger", async () => {
    const original = plainJpeg(10);
    const { env } = fakeEnv({ width: 100, height: 100, out: plainJpeg(500) });
    const out = await preparePhoto(file(original, "a.jpg", "image/jpeg"), 90 * MB, env);
    expect(await bytesOf(out as File)).toEqual(original);
  });

  it("sends the re-encode, not the original, when the original has Exif and the re-encode is larger", async () => {
    const { env } = fakeEnv({ width: 100, height: 100, out: plainJpeg(5000) });
    const out = await preparePhoto(file(exifJpeg(), "a.jpg", "image/jpeg"), 90 * MB, env);
    expect(await hasExif(out as File)).toBe(false);
  });

  it("keeps a PNG with transparency as it is, and encodes nothing", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { env, calls } = fakeEnv({ width: 400, height: 400, alpha: true });
    const out = await preparePhoto(file(png, "sticker.png", "image/png"), 90 * MB, env);
    expect(out?.name).toBe("sticker.png");
    expect(await bytesOf(out as File)).toEqual(png);
    expect(calls.encoded).toBe(0);
  });

  it("sends an opaque PNG as a JPEG named .jpg", async () => {
    const png = new Uint8Array(5000);
    const { env } = fakeEnv({ width: 400, height: 400 });
    const out = await preparePhoto(file(png, "shot.PNG", "image/png"), 90 * MB, env);
    expect(out?.name).toBe("shot.jpg");
    expect(out?.type).toBe("image/jpeg");
  });

  it("keeps an opaque PNG when the JPEG comes out larger", async () => {
    const png = new Uint8Array(20);
    const { env } = fakeEnv({ width: 40, height: 40, out: plainJpeg(500) });
    const out = await preparePhoto(file(png, "flat.png", "image/png"), 90 * MB, env);
    expect(out?.name).toBe("flat.png");
  });

  it("falls back to the original when decoding fails and it is under the cap and has no Exif", async () => {
    const { env } = fakeEnv({ width: 1, height: 1, decodeFails: true });
    const out = await preparePhoto(file(plainJpeg(), "a.jpg", "image/jpeg"), MB, env);
    expect(out?.name).toBe("a.jpg");
  });

  it("refuses when decoding fails and the original is over the cap, or carries Exif", async () => {
    const { env } = fakeEnv({ width: 1, height: 1, decodeFails: true });
    expect(await preparePhoto(file(plainJpeg(2000), "a.jpg", "image/jpeg"), 100, env)).toBeNull();
    expect(await preparePhoto(file(exifJpeg(), "a.jpg", "image/jpeg"), MB, env)).toBeNull();
  });

  it("keeps the original when the browser cannot encode a JPEG", async () => {
    const { env } = fakeEnv({ width: 10, height: 10 });
    const png = {
      ...env,
      surface: (w: number, h: number) => ({
        ...env.surface(w, h),
        encode: async () => new Blob(["x"], { type: "image/png" }),
      }),
    };
    const out = await preparePhoto(file(plainJpeg(), "a.jpg", "image/jpeg"), MB, png);
    expect(out?.name).toBe("a.jpg");
  });

  it("refuses an output over the cap", async () => {
    const { env } = fakeEnv({ width: 100, height: 100, out: plainJpeg(500) });
    expect(await preparePhoto(file(exifJpeg(100000), "a.jpg", "image/jpeg"), 100, env)).toBeNull();
  });
});
