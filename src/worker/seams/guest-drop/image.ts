// Pixel dimensions from an image's own headers (DROP-16), so a 30,000 x 30,000 file that would take down the room
// screen's tab is refused before it is stored as a library file. PNG and WebP sizes sit in the head. A JPEG's frame
// header sits behind metadata of any length and a GIF holds a frame descriptor per frame, so those are walked under
// `WALK_LIMITS`, through a reader from `planReads` (the caller's), so a small object costs its one read. A header that
// is not where the format puts it is a malformed file.
import { ascii } from "./bytes.ts";
import { type Check, fail, OK } from "./formats.ts";
import { readExact } from "./index.ts";
import { type PlannedReader, READ_PLAN } from "./read-plan.ts";

/** A 48 MP phone photo passes; the decoded size of one frame stays near 400 MB at most. */
export const MAX_PIXELS = 100_000_000;

interface Limits {
  /** Bytes per read; a read lands on the header the walk needs next. */
  blockBytes: number;
  /** Reads of its own, below what the plan has left; without one the walk may spend all the plan has left. */
  maxReads?: number;
  /** Length-bearing JPEG segments, or GIF blocks (extensions and frames). */
  maxSegments: number;
  /** Every marker, fill byte or sub-block the walk steps over. */
  maxSteps: number;
}
/**
 * Past any cap the file is malformed. A JPEG's headers sit in its first MiB (a segment is at most 64 KiB, an
 * extended XMP packet a few of them). A GIF is walked to its trailer, frame data included, in 8 MiB windows, as many
 * as the plan has left, and a sub-block per 255 bytes of what the plan could read; these caps bound its CPU.
 */
export const WALK_LIMITS = {
  jpeg: { blockBytes: 256 * 1024, maxReads: 4, maxSegments: 256, maxSteps: 8192 },
  gif: {
    blockBytes: READ_PLAN.maxReadBytes,
    maxSegments: 1_000_000,
    maxSteps: Math.ceil((READ_PLAN.maxReads * READ_PLAN.maxReadBytes) / 255),
  },
} as const satisfies Record<string, Limits>;

export interface Dimensions {
  width: number;
  height: number;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const bad = (reason: string) => fail("bad_structure", reason);

type Bytes = (at: number, n: number) => Promise<Uint8Array | null>;

/** The `n` bytes at `at` (n at most one block), read a block at a time; null past the end or the read cap. */
function walker(r: PlannedReader, limits: Limits): Bytes {
  let block: Uint8Array = new Uint8Array();
  let blockAt = 0;
  let reads = 0;
  const maxReads = Math.min(limits.maxReads ?? Number.POSITIVE_INFINITY, r.readsLeft());
  return async (at, n) => {
    if (at + n > r.size) return null;
    if (at < blockAt || at + n > blockAt + block.length) {
      if (++reads > maxReads) return null;
      const want = Math.min(limits.blockBytes, r.size - at);
      if (want < n) return null;
      const read = await readExact(r, at, want);
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
  const limits = WALK_LIMITS.jpeg;
  let segments = 0;
  for (let at = 2, steps = 0; steps < limits.maxSteps; steps++) {
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
    if (length < 2 || ++segments > limits.maxSegments) return null;
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

/** The bytes a color table flag and size in `packed` add. */
const colorTable = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);

/**
 * Every image descriptor up to the trailer: each frame within the pixel cap and, offset included, inside the logical
 * screen (a browser decodes the frame, not the screen). Extension and image data sub-blocks are stepped over. A file
 * with no frame, or anything but an extension, a frame or the trailer where a block starts, is malformed.
 */
async function gifFrames(bytes: Bytes, screen: Dimensions): Promise<Check> {
  const limits = WALK_LIMITS.gif;
  const packed = await bytes(10, 1);
  if (!packed) return bad("gif header");
  let at = 13 + colorTable(packed[0] as number);
  let frames = 0;
  for (let blocks = 0, steps = 0; blocks < limits.maxSegments; blocks++) {
    const intro = (await bytes(at, 1))?.[0];
    if (intro === 0x3b) return frames > 0 ? OK : bad("gif without a frame");
    if (intro === 0x2c) {
      const d = await bytes(at, 10);
      if (!d) return bad("gif frame");
      const v = view(d);
      const [left, top] = [v.getUint16(1, true), v.getUint16(3, true)];
      const frame = { width: v.getUint16(5, true), height: v.getUint16(7, true) };
      const sized = checkPixels(frame);
      if (!sized.ok) return sized;
      if (left + frame.width > screen.width || top + frame.height > screen.height) {
        return bad("gif frame outside the screen");
      }
      frames++;
      at += 10 + colorTable(d[9] as number) + 1; // descriptor, local color table, LZW code size
    } else if (intro === 0x21)
      at += 2; // introducer and label
    else return bad("gif block");
    for (let size = -1; size !== 0; steps++) {
      const sub = await bytes(at, 1);
      if (!sub || steps >= limits.maxSteps) return bad("gif data");
      size = sub[0] as number;
      at += 1 + size;
    }
  }
  return bad("gif blocks");
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

/** The size an image declares, within the cap: a GIF's logical screen and every frame. */
export async function checkImageSize(
  kind: "jpg" | "png" | "gif" | "webp",
  r: PlannedReader,
  head: Uint8Array,
): Promise<Check> {
  switch (kind) {
    case "jpg":
      return checkPixels(await jpeg(walker(r, WALK_LIMITS.jpeg)));
    case "png":
      return checkPixels(png(head));
    case "webp":
      return checkPixels(webp(head));
    case "gif": {
      const screen = gif(head);
      const sized = checkPixels(screen);
      return sized.ok && screen ? gifFrames(walker(r, WALK_LIMITS.gif), screen) : sized;
    }
  }
}
