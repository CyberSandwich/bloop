// A photo is re-encoded on the phone before it is sent: smaller on venue Wi-Fi, and a canvas writes no metadata, so
// the GPS location and every other Exif field are gone (VID-04's photo twin). The server checks all stay.

export const LONG_SIDE = 2560;
const QUALITY = 0.82;
const EXIF_SCAN = 65536;

/**
 * Whole pixels, the long side at most LONG_SIDE; a smaller image keeps its size.
 * @param {number} width
 * @param {number} height
 */
export function fitSize(width, height) {
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * True when the file's JPEG segments before the image data hold an Exif APP1 (where the location lives).
 * @param {{slice: (a: number, b: number) => {arrayBuffer: () => Promise<ArrayBuffer>}}} file
 */
export async function hasExif(file) {
  const b = new Uint8Array(await file.slice(0, EXIF_SCAN).arrayBuffer());
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1];
    const len = ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0);
    if (marker === 0xda) return false;
    if (marker === 0xe1 && b[at + 4] === 0x45 && b[at + 5] === 0x78) return true;
    at += 2 + len;
  }
  return false;
}

/**
 * @typedef {object} Surface
 * @property {(bitmap: unknown) => void} draw the bitmap, scaled to the surface
 * @property {() => boolean} hasAlpha
 * @property {(quality: number) => Promise<Blob | null>} encode as JPEG
 */
/** What the browser provides, so the unit tests (no canvas) can fake it.
 * @typedef {object} PhotoEnv
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
        encode: (quality) =>
          canvas.convertToBlob
            ? canvas.convertToBlob({ type: "image/jpeg", quality })
            : new Promise((done) => canvas.toBlob(done, "image/jpeg", quality)),
      };
    },
  };
}

/**
 * The file to send for a JPEG or PNG: a JPEG at q0.82, its long side at most LONG_SIDE and no metadata. The original
 * goes instead only when it carries no Exif and the re-encode is not smaller or could not be made (a PNG with
 * transparency, which has no location, is always sent as it is). Null: nothing safe to send under the cap.
 * @param {File} file
 * @param {number} maxBytes
 * @param {PhotoEnv} [env]
 * @returns {Promise<File | null>}
 */
export async function preparePhoto(file, maxBytes, env = browserEnv()) {
  const jpeg = /\.jpe?g$/i.test(file.name);
  const original = async () => (file.size <= maxBytes && !(jpeg && (await hasExif(file))) ? file : null);
  let bitmap;
  try {
    bitmap = await env.decode(file, { imageOrientation: "from-image" });
  } catch {
    return original();
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height);
  let source = bitmap;
  if (width < bitmap.width || height < bitmap.height) {
    try {
      const small = await env.decode(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
      if (small.width === width && small.height === height) source = small;
    } catch {
      // the drawImage below scales it
    }
  }
  const surface = env.surface(width, height);
  surface.draw(source);
  const alpha = !jpeg && surface.hasAlpha();
  const blob = alpha ? null : await surface.encode(QUALITY);
  if (source !== bitmap) source.close?.();
  bitmap.close?.();
  if (alpha || blob?.type !== "image/jpeg") return original();
  const kept = blob.size < file.size ? null : await original();
  if (kept) return kept;
  return blob.size > maxBytes ? null : new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
}
