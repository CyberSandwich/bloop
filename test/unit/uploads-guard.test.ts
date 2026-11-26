import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { crc32 } from "../../src/worker/crc32.ts";
import { capReads, checkStored, readBudget } from "../../src/worker/uploads/check.ts";
import { validVideo } from "../zip-builder.ts";
import { fakeMultipart } from "./fake-multipart.ts";

const DIR = fileURLToPath(new URL("../../src/worker/uploads/", import.meta.url));

describe("the ordering rule lives in one place", () => {
  it("only reclaim.ts deletes an object or aborts a multipart, but for create's undo of a multipart no row names", () => {
    const calls = readdirSync(DIR)
      .filter((f) => f.endsWith(".ts") && f !== "reclaim.ts")
      .flatMap((f) =>
        readFileSync(join(DIR, f), "utf8")
          .split("\n")
          .filter((line) => /\bmp\.(delete|abort)\(/.test(line))
          .map((line) => `${f}: ${line.trim()}`),
      );
    expect(calls).toEqual(["pipeline.ts: await d.mp.abort(key, r2UploadId);"]);
  });
});

describe("the validation read stays within what was charged", () => {
  const counting = (size: number) => {
    let reads = 0;
    return {
      reader: {
        size,
        read: async (_offset: number, length: number) => {
          reads += 1;
          return new Uint8Array(length);
        },
      },
      reads: () => reads,
    };
  };

  it("a reader past its budget reads nothing more and marks the check over", async () => {
    const inner = counting(1000);
    const capped = capReads(inner.reader, 3);
    for (let i = 0; i < 5; i++) await capped.reader.read(0, 10);
    expect(inner.reads()).toBe(3);
    expect(capped.over()).toBe(true);
    expect(await capped.reader.read(0, 10)).toEqual(new Uint8Array());
  });

  it("a reader within its budget passes every read through", async () => {
    const inner = counting(1000);
    const capped = capReads(inner.reader, 3);
    for (let i = 0; i < 3; i++) expect(await capped.reader.read(0, 10)).toHaveLength(10);
    expect(capped.over()).toBe(false);
  });

  it("UP-13 crc32: a large object is streamed once for its digests and validated within the charged reads", async () => {
    const digests = globalThis.crypto as unknown as Record<string, unknown>;
    digests.DigestStream = class extends WritableStream<Uint8Array> {
      digest: Promise<ArrayBuffer>;
      constructor() {
        const hash = createHash("sha256");
        let done: (b: ArrayBuffer) => void = () => {};
        super({ write: (chunk) => void hash.update(chunk), close: () => done(new Uint8Array(hash.digest()).buffer) });
        this.digest = new Promise((resolve) => {
          done = resolve;
        });
      }
    };
    try {
      const video = validVideo("isom", 17 * 1024 * 1024);
      const mp = fakeMultipart();
      mp.objects.set("k", video);
      let charged = 0;
      const out = await checkStored(mp, "k", video.length, "mp4", {
        deadline: Number.POSITIVE_INFINITY,
        now: () => 0,
        charge: async (n) => {
          charged += n;
          return true;
        },
      });
      expect(out).toMatchObject({
        ok: true,
        type: "mp4",
        crc32: crc32(video),
        sha256: createHash("sha256").update(video).digest("hex"),
      });
      expect(charged).toBe(readBudget(video.length));
      expect(mp.calls.filter((c) => c.startsWith("get")).length).toBeLessThanOrEqual(charged);
    } finally {
      delete digests.DigestStream;
    }
  });

  it("the budget covers the stream, the validator's head and tail reads and its own cap", () => {
    expect(readBudget(1)).toBe(1);
    expect(readBudget(500 * 1024 * 1024)).toBeGreaterThanOrEqual(1 + 4 + 64);
  });
});
