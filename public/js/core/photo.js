// VID-04: a canvas writes no metadata, so a re-encoded photo has no Exif, XMP or IPTC.

export const LONG_SIDE = 2560;
const QUALITY = 0.82;

/** Whole pixels, the long side at most LONG_SIDE. @param {number} width @param {number} height */
export function fitSize(width, height) {
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * @typedef {object} Surface
 * @property {(bitmap: unknown) => void} draw
 * @property {() => boolean} hasAlpha
 * @property {(type: string, quality: number) => Promise<Blob | null>} encode
 */
/** @typedef {object} PhotoEnv
 * @property {(src: unknown, options: object) => Promise<{width: number, height: number, close?: () => void}>} decode
 * @property {(width: number, height: number) => Surface} surface
 */

/** @returns {PhotoEnv} */
function browserEnv() {
  const g = /** @type {any} */ (globalThis);
  return {
    decode: (src, options) => g.createImageBitmap(src, options),
    surface(width, height) {
      const canvas =
        typeof g.OffscreenCanvas === "function"
          ? new g.OffscreenCanvas(width, height)
          : Object.assign(g.document.createElement("canvas"), { width, height });
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingQuality = "high";
      return {
        draw: (bitmap) => ctx.drawImage(bitmap, 0, 0, width, height),
        hasAlpha: () => {
          const px = ctx.getImageData(0, 0, width, height).data;
          for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return true;
          return false;
        },
        encode: (type, quality) =>
          canvas.convertToBlob
            ? canvas.convertToBlob({ type, quality })
            : new Promise((done) => canvas.toBlob(done, type, quality)),
      };
    },
  };
}

/**
 * The canvas re-encode of a JPEG, PNG or HEIC (PNG only with transparency); the original's bytes never go (Privacy 3.4).
 * @param {File} file
 * @param {number} maxBytes
 * @param {PhotoEnv} [env]
 * @returns {Promise<{ok: true, file: File} | {ok: false, reason: "decode" | "encode" | "large"}>}
 */
export async function preparePhoto(file, maxBytes, env = browserEnv()) {
  let bitmap;
  try {
    bitmap = await env.decode(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "decode" };
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height);
  let source = bitmap;
  if (width < bitmap.width || height < bitmap.height) {
    try {
      const small = await env.decode(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
      if (small.width === width && small.height === height) source = small;
    } catch {
      // drawImage scales
    }
  }
  const jpeg = /\.jpe?g$/i.test(file.name);
  let type = "image/jpeg";
  let blob = null;
  try {
    const surface = env.surface(width, height);
    surface.draw(source);
    if (!jpeg && surface.hasAlpha()) type = "image/png";
    blob = await surface.encode(type, QUALITY);
  } catch {
    // an encode refusal
  } finally {
    if (source !== bitmap) source.close?.();
    bitmap.close?.();
  }
  if (blob?.type !== type) return { ok: false, reason: "encode" };
  if (blob.size > maxBytes) return { ok: false, reason: "large" };
  const name = file.name.replace(/\.\w+$/, type === "image/png" ? ".png" : ".jpg");
  return { ok: true, file: new File([blob], name, { type }) };
}
