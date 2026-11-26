import { afterEach, describe, expect, it, vi } from "vitest";
import { checkImageSize, WALK_LIMITS } from "../../src/worker/seams/guest-drop/image.ts";
import { validate } from "../../src/worker/seams/guest-drop/validate.ts";
import { concat, gifExtension, reader } from "../zip-builder.ts";

const enc = new TextEncoder();
const refused = (error: string) => ({ ok: false, error });
const u16 = (n: number) => [n & 255, n >> 8];
/** A frame descriptor at (`left`, `top`) of `w` x `h`, no local color table, then its image data sub-blocks. */
const frame = (w: number, h: number, left = 0, top = 0, data: Uint8Array = new Uint8Array([2, 0])) =>
  concat([new Uint8Array([0x2c, ...u16(left), ...u16(top), ...u16(w), ...u16(h), 0]), data]);
/** A 100 x 100 GIF of the given blocks, then the trailer. */
const gif = (...blocks: Uint8Array[]) =>
  concat([enc.encode("GIF89a"), new Uint8Array([100, 0, 100, 0, 0, 0, 0]), ...blocks, new Uint8Array([0x3b])]);
const check = (bytes: Uint8Array) => validate(reader(bytes), "gif");

describe("DROP-16 pixels: a GIF frame lies inside the logical screen", () => {
  it("DROP-16 pixels: refuses a frame whose offset plus size passes the screen (offset ignored)", async () => {
    expect(await check(gif(frame(50, 50, 50, 50)))).toEqual({ ok: true, type: "gif" });
    expect(await check(gif(frame(50, 50, 51, 0)))).toEqual(refused("bad_structure"));
    expect(await check(gif(frame(50, 50, 0, 51)))).toEqual(refused("bad_structure"));
    expect(await check(gif(frame(100, 100), frame(1, 1, 65535, 65535)))).toEqual(refused("bad_structure"));
  });
});

describe("DROP-16 pixels: the GIF walk's caps", () => {
  const limits = WALK_LIMITS.gif;

  it("refuses an unknown block where a block starts", async () => {
    expect(await check(gif(frame(10, 10), new Uint8Array([0x99, 0])))).toEqual(refused("bad_structure"));
    expect(await check(gif(new Uint8Array([0x00])))).toEqual(refused("bad_structure"));
  });

  it("refuses a GIF with more blocks than maxSegments (trailer included), and passes one at the cap", async () => {
    const ext = gifExtension(0x01, new Uint8Array());
    const blocks = (n: number) => new Uint8Array(n * ext.length).map((_, i) => ext[i % ext.length] as number);
    expect(await check(gif(blocks(limits.maxSegments - 2), frame(10, 10)))).toEqual({ ok: true, type: "gif" });
    expect(await check(gif(blocks(limits.maxSegments - 1), frame(10, 10)))).toEqual(refused("bad_structure"));
  }, 60_000);

  it("refuses a GIF with more sub-blocks than maxSteps, and passes one at the cap", async () => {
    // One frame whose data is `n` one-byte sub-blocks, then the terminator: n + 1 steps.
    const data = (n: number) => {
      const out = new Uint8Array(1 + 2 * n + 1);
      out[0] = 2;
      for (let i = 0; i < n; i++) out[1 + 2 * i] = 1;
      return out;
    };
    const at = (n: number) => gif(frame(10, 10, 0, 0, data(n)));
    expect(await check(at(limits.maxSteps - 1))).toEqual({ ok: true, type: "gif" });
    expect(await check(at(limits.maxSteps))).toEqual(refused("bad_structure"));
  }, 60_000);

  it("stops after maxReads windows and refuses the GIF", async () => {
    const head = gif(frame(10, 10)).subarray(0, 13 + 10 + 1);
    const size = (limits.maxReads + 2) * limits.blockBytes;
    let reads = 0;
    const endless = {
      size,
      read: async (o: number, n: number) => {
        reads++;
        const out = new Uint8Array(n);
        const first = o < head.length ? head.length - o : (256 - ((o - head.length) % 256)) % 256;
        for (let i = first; i < n; i += 256) out[i] = 255;
        if (o < head.length) out.set(head.subarray(o, o + n));
        return out;
      },
    };
    expect(await checkImageSize("gif", endless, head)).toMatchObject({ ok: false, error: "bad_structure" });
    expect(reads).toBe(limits.maxReads);
  }, 60_000);
});

describe("DROP-16 pixels: the GIF walk's wall time", () => {
  afterEach(() => vi.restoreAllMocks());

  it("DROP-16 pixels: refuses a walk past maxMs as service_busy, which a retry may clear (no wall time)", async () => {
    const lzw = concat([
      new Uint8Array([2]),
      ...Array.from({ length: 50 }, () => new Uint8Array([1, 0])),
      new Uint8Array([0]),
    ]);
    const file = gif(frame(10, 10, 0, 0, lzw));
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += WALK_LIMITS.gif.maxMs / 10));
    expect(await check(file)).toEqual(refused("service_busy"));
    vi.restoreAllMocks();
    expect(await check(file)).toEqual({ ok: true, type: "gif" });
  });
});
