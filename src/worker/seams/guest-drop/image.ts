// Pixel dimensions from an image's own headers (DROP-16), so a 30,000 x 30,000 file that would take down the room
// screen's tab is refused before it is stored as a library file. Reads only the head; a header that is not where the
// format puts it is a malformed file.
import { ascii } from "./bytes.ts";
import { type Check, fail, OK } from "./formats.ts";

/** A 48 MP phone photo passes; the decoded size of one frame stays near 400 MB at most. */
export const MAX_PIXELS = 100_000_000;
/** How much of a JPEG's head holds its markers: a frame header sits after the EXIF and ICC segments. */
export const JPEG_SCAN_BYTES = 256 * 1024;

export interface Dimensions {
  width: number;
  height: number;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** IHDR is always the first chunk: width and height at bytes 16 and 20. */
function png(head: Uint8Array): Dimensions | null {
  if (head.length < 24 || ascii(head, 12, 4) !== "IHDR") return null;
  const v = view(head);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Walks the marker segments to the first frame header; null at a scan, the end marker or a bad length. */
function jpeg(head: Uint8Array): Dimensions | null {
  const v = view(head);
  for (let at = 2; at + 4 <= head.length; ) {
    if (head[at] !== 0xff) return null;
    const marker = head[at + 1] as number;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // standalone markers carry no length
      continue;
    }
    const length = v.getUint16(at + 2);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker))
      return at + 9 <= head.length ? { height: v.getUint16(at + 5), width: v.getUint16(at + 7) } : null;
    at += 2 + length;
  }
  return null;
}

/** The logical screen descriptor follows the six byte signature. */
function gif(head: Uint8Array): Dimensions | null {
  if (head.length < 10) return null;
  const v = view(head);
  return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
}

/** The first chunk after `WEBP` is `VP8 ` (lossy), `VP8L` (lossless) or `VP8X` (extended); each stores size its own way. */
function webp(head: Uint8Array): Dimensions | null {
  if (head.length < 25) return null;
  const v = view(head);
  const kind = ascii(head, 12, 4);
  if (kind !== "VP8L" && head.length < 30) return null;
  switch (kind) {
    case "VP8 ":
      return head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a
        ? { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff }
        : null;
    case "VP8L": {
      if (head[20] !== 0x2f) return null;
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      return {
        width: ((head[24] as number) | ((head[25] as number) << 8) | ((head[26] as number) << 16)) + 1,
        height: ((head[27] as number) | ((head[28] as number) << 8) | ((head[29] as number) << 16)) + 1,
      };
    default:
      return null;
  }
}

const READERS = { png, jpg: jpeg, gif, webp };

/** The pixel size an image declares; null when its header is missing or malformed. */
export const dimensions = (kind: keyof typeof READERS, head: Uint8Array): Dimensions | null => READERS[kind](head);

/** Refuses a missing or empty size as damaged and a frame over `MAX_PIXELS` as too large. */
export function checkPixels(size: Dimensions | null): Check {
  if (size === null || size.width === 0 || size.height === 0) return fail("bad_structure", "image size");
  return size.width * size.height > MAX_PIXELS ? fail("too_large", "image pixels") : OK;
}
