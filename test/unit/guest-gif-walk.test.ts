import { describe, expect, it } from "vitest";
import { checkImageSize, WALK_LIMITS } from "../../src/worker/seams/guest-drop/image.ts";
import { planReads, READ_PLAN } from "../../src/worker/seams/guest-drop/read-plan.ts";
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
  it("DROP-16 pixels: refuses a frame whose offset plus size passes the screen (the offset was not checked)", async () => {
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

  it("passes a GIF whose blocks and trailer number maxSegments, and refuses one block more", async () => {
    const ext = gifExtension(0x01, new Uint8Array());
    const blocks = (n: number) => new Uint8Array(n * ext.length).map((_, i) => ext[i % ext.length] as number);
    expect(await check(gif(blocks(limits.maxSegments - 2), frame(10, 10)))).toEqual({ ok: true, type: "gif" });
    expect(await check(gif(blocks(limits.maxSegments - 1), frame(10, 10)))).toEqual(refused("bad_structure"));
  }, 60_000);

  it("passes a GIF whose sub-blocks and terminator number maxSteps, and refuses one sub-block more", async () => {
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

  it("stops the walk at the reads the plan has left and refuses the GIF (a second read cap past the plan)", async () => {
    const head = gif(frame(10, 10)).subarray(0, 13 + 10 + 1);
    let reads = 0;
    // A frame whose 255-byte sub-blocks run on past what the plan can read.
    const endless = {
      size: (READ_PLAN.maxReads + 2) * limits.blockBytes,
      read: async (o: number, n: number) => {
        reads++;
        const out = new Uint8Array(n);
        const first = o < head.length ? head.length - o : (256 - ((o - head.length) % 256)) % 256;
        for (let i = first; i < n; i += 256) out[i] = 255;
        if (o < head.length) out.set(head.subarray(o, o + n));
        return out;
      },
    };
    for (const spent of [3, 10]) {
      reads = 0;
      const plan = planReads(endless);
      for (let i = 0; i < spent; i++) await plan.read(0, 1);
      expect(plan.readsLeft()).toBe(READ_PLAN.maxReads - spent);
      expect(await checkImageSize("gif", plan, head)).toMatchObject({ ok: false, error: "bad_structure" });
      expect(reads, `${spent} spent first`).toBe(READ_PLAN.maxReads);
    }
  }, 60_000);
});
