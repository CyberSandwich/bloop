// A photo is re-encoded on the phone before it is sent: smaller on venue Wi-Fi, and a canvas writes no metadata, so
// the GPS location and every other Exif, XMP or IPTC field are gone (VID-04's photo twin). The server checks all stay.

export const LONG_SIDE = 2560;
const QUALITY = 0.82;
const SEGMENT_SCAN = 65536;

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
 * False only when the JPEG's segments are walked to the image data with no APP1 (Exif or XMP, where a location
 * lives) and no APP13 (IPTC); a structure it cannot walk counts as metadata.
 * @param {{slice: (a: number, b: number) => {arrayBuffer: () => Promise<ArrayBuffer>}}} file
 */
export async function hasMetadata(file) {
  const b = new Uint8Array(await file.slice(0, SEGMENT_SCAN).arrayBuffer());
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1];
    if (marker === 0xda) return false;
    if (marker === 0xe1 || marker === 0xed) return true;
    at += 2 + (((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
  }
  return true;
}

/**
 * @typedef {object} Surface
 * @property {(bitmap: unknown) => void} draw the bitmap, scaled to the surface
 * @property {() => boolean} hasAlpha
 * @property {(type: string, quality: number) => Promise<Blob | null>} encode
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
        encode: (type, quality) =>
          canvas.convertToBlob
            ? canvas.convertToBlob({ type, quality })
            : new Promise((done) => canvas.toBlob(done, type, quality)),
      };
    },
  };
}

/**
 * The file to send for a JPEG, PNG or HEIC, as the canvas wrote it: a JPEG at q0.82 (a PNG with transparency stays a
 * PNG), its long side at most LONG_SIDE and no metadata. Only a JPEG with no metadata segment may go as it is, when
 * the re-encode is not smaller or could not be made. Null: nothing safe to send under the cap, a HEIC this browser
 * cannot decode among them.
 * @param {File} file
 * @param {number} maxBytes
 * @param {PhotoEnv} [env]
 * @returns {Promise<File | null>}
 */
export async function preparePhoto(file, maxBytes, env = browserEnv()) {
  const jpeg = /\.jpe?g$/i.test(file.name);
  const original = async () => (jpeg && file.size <= maxBytes && !(await hasMetadata(file)) ? file : null);
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
  const type = !jpeg && surface.hasAlpha() ? "image/png" : "image/jpeg";
  const blob = await surface.encode(type, QUALITY);
  if (source !== bitmap) source.close?.();
  bitmap.close?.();
  if (blob?.type !== type) return original();
  const kept = blob.size < file.size ? null : await original();
  if (kept) return kept;
  const name = file.name.replace(/\.\w+$/, type === "image/png" ? ".png" : ".jpg");
  return blob.size > maxBytes ? null : new File([blob], name, { type });
}
