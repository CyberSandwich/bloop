// The preview sheet's minted /p/ links (public/js/library/preview.js): reused while they have time left, never kept
// when refused.
import { describe, expect, it, vi } from "vitest";

// A specifier in a variable: the node tsconfig has no DOM lib, so it must not follow this import into page code.
const PREVIEW = "../../public/js/library/preview.js";
// ui.js (which preview.js imports) tracks the last input kind from its first line.
vi.stubGlobal("addEventListener", () => {});
const { start }: { start: (page: unknown) => { prefetch: (id: string) => void } } = await import(PREVIEW);

const image = {
  id: "a",
  name: "Dog.jpg",
  ext: "jpg",
  kind: "image",
  bytes: 1,
  status: "ready",
  updatedAt: 0,
  selected: false,
  disabled: false,
  derived: { state: "none" },
};

/** A page whose preview POSTs answer in turn; `calls` counts them. */
function previewWith(answers: unknown[]) {
  const calls: unknown[] = [];
  const page = {
    list: () => ({ switches: { previews: "on" } }),
    row: () => image,
    path: (id: string) => `/api/library/${id}`,
    net: {
      call: async (...args: unknown[]) => {
        calls.push(args);
        return answers.shift();
      },
    },
  };
  return { preview: start(page), calls };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const minted = (msLeft: number) => ({
  ok: true,
  status: 200,
  value: { base: "https://f/p/t", exp: Date.now() + msLeft },
});

/** Two prefetches of the same row, each left to settle. */
async function twice(answers: unknown[]) {
  const { preview, calls } = previewWith(answers);
  preview.prefetch("a");
  await settle();
  preview.prefetch("a");
  await settle();
  return calls.length;
}

describe("the preview's minted links", () => {
  it("reuses a link with time left", async () => {
    expect(await twice([minted(300_000)])).toBe(1);
  });
  it("does not keep a refusal: the next tap asks again", async () => {
    expect(await twice([{ ok: false, status: 503, code: "service_busy" }, minted(300_000)])).toBe(2);
  });
  it("mints again a link within its last 15 seconds", async () => {
    expect(await twice([minted(10_000), minted(300_000)])).toBe(2);
  });
});
