// Pixel dimensions from an image's own headers (DROP-16), so a 30,000 x 30,000 file that would take down the room
// screen's tab is refused before it is stored as a library file. PNG and WebP sizes sit in the head; a JPEG's frame
// header and a GIF's first image descriptor sit behind metadata of any length, so those are walked with small range
// reads under `WALK_LIMITS`. A header that is not where the format puts it is a malformed file.
import { ascii } from "./bytes.ts";
import { type Check, fail, OK } from "./formats.ts";
import type { RangeReader } from "./index.ts";

/** A 48 MP phone photo passes; the decoded size of one frame stays near 400 MB at most. */
export const MAX_PIXELS = 100_000_000;
/**
 * A walk reads `blockBytes` at a time (a JPEG segment is at most 64 KiB, so a read lands on the next header), at
 * most `maxReads` times; it stops after `maxSegments` length-bearing segments or extension blocks and `maxSteps`
 * markers, fill bytes and sub-blocks in all. Past any cap the file is malformed.
 */
export const WALK_LIMITS = { blockBytes: 64 * 1024, maxReads: 32, maxSegments: 256, maxSteps: 8192 } as const;

export interface Dimensions {
  width: number;
  height: number;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

type Bytes = (at: number, n: number) => Promise<Uint8Array | null>;

/** The `n` bytes at `at` (n at most one block), read a block at a time; null past the end, a short read or the cap. */
function walker(r: RangeReader): Bytes {
  let block: Uint8Array = new Uint8Array();
  let blockAt = 0;
  let reads = 0;
  return async (at, n) => {
    if (at + n > r.size) return null;
    if (at < blockAt || at + n > blockAt + block.length) {
      if (++reads > WALK_LIMITS.maxReads) return null;
      const want = Math.min(WALK_LIMITS.blockBytes, r.size - at);
      const read = await r.read(at, want);
      if (read.length !== want || want < n) return null;
      [block, blockAt] = [read, at];
    }
    return block.subarray(at - blockAt, at - blockAt + n);
  };
}

/** IHDR is always the first chunk: width and height at bytes 16 and 20. */
function png(head: Uint8Array): Dimensions | null {
  if (head.length < 24 || ascii(head, 12, 4) !== "IHDR") return null;
  const v = view(head);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Walks the marker segments to the first frame header; null at a scan, the end marker, a bad length or a cap. */
async function jpeg(bytes: Bytes): Promise<Dimensions | null> {
  let segments = 0;
  for (let at = 2, steps = 0; steps < WALK_LIMITS.maxSteps; steps++) {
    const head = await bytes(at, 4);
    if (head?.[0] !== 0xff) return null;
    const marker = head[1] as number;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // standalone markers carry no length
      continue;
    }
    const length = view(head).getUint16(2);
    if (length < 2 || ++segments > WALK_LIMITS.maxSegments) return null;
    if (SOF_MARKERS.has(marker)) {
      const frame = await bytes(at + 5, 4);
      return frame ? { height: view(frame).getUint16(0), width: view(frame).getUint16(2) } : null;
    }
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

/**
 * The first image descriptor, past the global color table and any extension blocks: a frame may be larger than the
 * logical screen, and a browser decodes the frame. Null at the trailer or anything else before a frame.
 */
async function gifFrame(bytes: Bytes): Promise<Dimensions | null> {
  const screen = await bytes(10, 1);
  if (!screen) return null;
  const packed = screen[0] as number;
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  for (let steps = 0, blocks = 0; steps < WALK_LIMITS.maxSteps && blocks <= WALK_LIMITS.maxSegments; blocks++) {
    const intro = await bytes(at, 1);
    if (intro?.[0] === 0x2c) {
      const frame = await bytes(at + 5, 4);
      return frame ? { width: view(frame).getUint16(0, true), height: view(frame).getUint16(2, true) } : null;
    }
    if (intro?.[0] !== 0x21) return null;
    at += 2; // introducer and label, then the data sub-blocks up to an empty one
    for (let size = -1; size !== 0; steps++) {
      const sub = await bytes(at, 1);
      if (!sub || steps >= WALK_LIMITS.maxSteps) return null;
      size = sub[0] as number;
      at += 1 + size;
    }
  }
  return null;
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

/** Refuses a missing or empty size as damaged and a frame over `MAX_PIXELS` as too large. */
function checkPixels(size: Dimensions | null): Check {
  if (size === null || size.width === 0 || size.height === 0) return fail("bad_structure", "image size");
  return size.width * size.height > MAX_PIXELS ? fail("too_large", "image pixels") : OK;
}

/** The size an image declares, within the cap: a GIF's logical screen and its first frame both. */
export async function checkImageSize(
  kind: "jpg" | "png" | "gif" | "webp",
  r: RangeReader,
  head: Uint8Array,
): Promise<Check> {
  switch (kind) {
    case "jpg":
      return checkPixels(await jpeg(walker(r)));
    case "png":
      return checkPixels(png(head));
    case "webp":
      return checkPixels(webp(head));
    case "gif": {
      const screen = checkPixels(gif(head));
      return screen.ok ? checkPixels(await gifFrame(walker(r))) : screen;
    }
  }
}
