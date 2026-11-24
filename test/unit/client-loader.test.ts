// The shared loading part's logic (public/js/core/loader.js): the byte count and the value the part shows.
import { describe, expect, it, vi } from "vitest";

// A specifier in a variable: the node tsconfig has no DOM lib, so it must not follow this import into page code.
const LOADER = "../../public/js/core/loader.js";
// ui.js (which loader.js imports) tracks the last input kind from its first line.
vi.stubGlobal("addEventListener", () => {});
const {
  readAll,
  setProgress,
}: {
  readAll: (res: Response, onProgress: (f: number | null) => void) => Promise<Blob>;
  setProgress: (part: unknown, f: number | null) => void;
} = await import(LOADER);

/** A response whose body arrives in the given chunks. */
const chunked = (sizes: number[], headers: Record<string, string>) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of sizes) c.enqueue(new Uint8Array(n));
        c.close();
      },
    }),
    { headers },
  );

describe("readAll", () => {
  it("reports the share received after each chunk, from 0, and keeps the type", async () => {
    const seen: (number | null)[] = [];
    const blob = await readAll(chunked([25, 25, 50], { "Content-Length": "100", "Content-Type": "image/jpeg" }), (f) =>
      seen.push(f),
    );
    expect(seen).toEqual([0, 0.25, 0.5, 1]);
    expect(blob.size).toBe(100);
    expect(blob.type).toBe("image/jpeg");
  });

  it("reports null, once, when the length is unknown", async () => {
    const seen: (number | null)[] = [];
    const blob = await readAll(chunked([10, 10], {}), (f) => seen.push(f));
    expect(seen).toEqual([null]);
    expect(blob.size).toBe(20);
  });

  it("reports null for an encoded body: its length counts other bytes than the reader sees", async () => {
    const seen: (number | null)[] = [];
    await readAll(chunked([10], { "Content-Length": "4", "Content-Encoding": "br" }), (f) => seen.push(f));
    expect(seen).toEqual([null]);
  });
});

describe("setProgress", () => {
  it("sets the value in whole percent and the fill as a fraction, clamped to 0..1", () => {
    const attrs = new Map<string, string>();
    const style = new Map<string, string>();
    const target = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) },
    };
    setProgress(target, 0.426);
    expect(attrs.get("aria-valuenow")).toBe("43");
    expect(style.get("--progress")).toBe("0.426");
    setProgress(target, 1.2);
    expect(attrs.get("aria-valuenow")).toBe("100");
    expect(style.get("--progress")).toBe("1");
    setProgress(target, null);
    expect(attrs.has("aria-valuenow")).toBe(false);
    expect(style.has("--progress")).toBe(false);
  });
});
