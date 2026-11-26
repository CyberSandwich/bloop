import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  CONTAINER_ERRORS,
  FULL_WIDTHS,
  KIND_BY_EXT,
  manifestSchema,
  metaSchema,
  notesSchema,
  OUTPUT_CAPS,
  STAGE_TIMEOUT_S,
  STAGES,
  slidesInSchema,
  statusSchema,
} from "../../src/worker/convert/contract.ts";

const readme = readFileSync(new URL("../../container/README.md", import.meta.url), "utf8");
const MIB = 1024 * 1024;

const row = (re: RegExp): string[] => {
  const m = re.exec(readme);
  if (!m) throw new Error(`README has no row matching ${re}`);
  return m.slice(1);
};

describe("convert contract matches container/README.md", () => {
  it("kinds and extensions", () => {
    const fromReadme: Record<string, string> = {};
    for (const [, kind, exts] of readme.matchAll(/^\| `(deck|doc|sheet|pdf|video|image)` \| `([^`]+)` \|$/gm)) {
      for (const ext of (exts as string).split(" ")) fromReadme[ext] = kind as string;
    }
    expect(KIND_BY_EXT).toEqual(fromReadme);
  });

  it("stages", () => {
    const list = row(/`stage` is ((?:`\w+`(?:, | or )?)+)\./)[0] as string;
    expect([...list.matchAll(/`(\w+)`/g)].map((m) => m[1])).toEqual([...STAGES]);
  });

  it("stage timeouts", () => {
    for (const [stage, seconds] of Object.entries(STAGE_TIMEOUT_S)) {
      expect(row(new RegExp(`^\\| ${stage} \\|.*\\| (\\d+) s \\|$`, "m"))[0]).toBe(String(seconds));
    }
  });

  it("error codes", () => {
    const line = row(/## Error codes\n\n(.+)\n/)[0] as string;
    expect([...line.matchAll(/`(\w+)`/g)].map((m) => m[1])).toEqual([...CONTAINER_ERRORS]);
  });

  it("chunk size and output caps", () => {
    expect(row(/^\| one chunk \| (\d+) MiB \|/m)[0]).toBe(String(CHUNK_BYTES / MIB));
    const line = row(/Size caps: (.+)\./)[0] as string;
    expect(line).toContain(`webp and jpeg ${OUTPUT_CAPS.webp / MIB} MiB`);
    expect(line).toContain("pdf 1 GiB, mp4 4 GiB");
    expect(line).toContain(`json ${OUTPUT_CAPS.json / MIB} MiB`);
    expect(line).toContain(`${OUTPUT_CAPS.total / MIB / 1024} GiB in total`);
  });

  it("default widths", () => {
    expect(row(/\(default (\d+, \d+, \d+); `BLOOP_WIDTHS`/)[0]).toBe(FULL_WIDTHS.join(", "));
  });

  it("names the output files the schemas parse", () => {
    for (const name of ["doc.pdf", "t.webp", "slides.json", "notes.json", "meta.json", "m/0.mp4", "i/1920.jpg"]) {
      expect(readme).toContain(name);
    }
  });
});

const hex = "a".repeat(64);

describe("convert contract schemas", () => {
  it("accepts a status and refuses an unknown code", () => {
    const ok = { state: "running", stage: "rasterize", pct: 40, error: null, pages: { done: 3, total: 9 }, ready: [] };
    expect(statusSchema.safeParse(ok).success).toBe(true);
    expect(statusSchema.safeParse({ ...ok, error: "oops" }).success).toBe(false);
    expect(statusSchema.safeParse({ ...ok, pct: 101 }).success).toBe(false);
  });

  it("parses a manifest strictly", () => {
    const ok = {
      v: 1,
      jobId: "f_v1_a1",
      kind: "deck",
      pages: { total: 2, rendered: 2 },
      groups: { slides: { ok: true } },
      files: [{ path: "doc.pdf", size: 5, sha256: hex, type: "application/pdf" }],
    };
    expect(manifestSchema.safeParse(ok).success).toBe(true);
    expect(manifestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...ok, files: [{ ...ok.files[0], sha256: "A".repeat(64) }] }).success).toBe(
      false,
    );
  });

  it("parses slides, notes and meta strictly", () => {
    const slides = { v: 1, widths: [1920], pages: [{ n: 1, w: 1920, h: 1080 }], motion: false, media: false };
    expect(slidesInSchema.safeParse(slides).success).toBe(true);
    expect(slidesInSchema.safeParse({ ...slides, notes: [] }).success).toBe(false);
    expect(notesSchema.safeParse({ v: 1, notes: [{ n: 1, text: "a\nb" }] }).success).toBe(true);
    expect(notesSchema.safeParse({ v: 1, notes: [{ n: 1, text: "a\u0001" }] }).success).toBe(false);
    expect(metaSchema.safeParse({ v: 1, sha256: hex, kind: "deck", fontsMissing: ["Aptos"] }).success).toBe(true);
    expect(metaSchema.safeParse({ v: 1, sha256: hex, kind: "deck", other: 1 }).success).toBe(false);
  });
});
