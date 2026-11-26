import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../src/worker/", import.meta.url).pathname;
const GUEST_DROP = "seams/guest-drop/";
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
/** Lines of every source file outside `except` that match `pattern`, as `file: line`. */
const lines = (pattern: RegExp, except: string[] = []): string[] =>
  sources(ROOT)
    .map((f) => f.slice(ROOT.length))
    .filter((f) => !except.includes(f))
    .flatMap((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .filter((l) => pattern.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );

describe("a declared size in an untrusted container is a claim, never a measure", () => {
  it("keeps the sizes a zip declares inside zip.ts and the read plan", () => {
    expect(lines(/\.(un)?compressed\b/, [`${GUEST_DROP}zip.ts`, `${GUEST_DROP}read-plan.ts`])).toEqual([]);
  });

  it("budgets by the length of what was read, as the relationships reader does", () => {
    const src = readFileSync(`${ROOT}${GUEST_DROP}validate.ts`, "utf8");
    expect(src).toMatch(/budget -= bytes\.length/);
  });
});

describe("a validator reads through the read plan, never entry by entry", () => {
  it("calls the range reader only in readExact and the read plan (raw reads in validators)", () => {
    expect(lines(/\br\.read\(/).sort()).toEqual(
      [
        `${GUEST_DROP}index.ts: const bytes = await r.read(offset, length);`,
        `${GUEST_DROP}read-plan.ts: whole ??= r.read(0, r.size);`,
        `${GUEST_DROP}read-plan.ts: return r.read(offset, length);`,
        `${GUEST_DROP}read-plan.ts: const bytes = await r.read(from, to - from);`,
        `${GUEST_DROP}read-plan.ts: const rest = await r.read(from + at, size);`,
      ].sort(),
    );
    const validators = ["validate", "zip", "cfb", "image", "pdf-scan", "formats"].map((f) => `${GUEST_DROP}${f}.ts`);
    const all = sources(ROOT).map((f) => f.slice(ROOT.length));
    expect(
      lines(
        /\.read\(/,
        all.filter((f) => !validators.includes(f)),
      ),
    ).toEqual([]);
  });

  it("plans the reads once, in validate, for every validator (one plan per object)", () => {
    const validate = readFileSync(`${ROOT}${GUEST_DROP}validate.ts`, "utf8");
    expect(validate.match(/planReads\(/g)).toHaveLength(1);
    expect(validate).toMatch(/validatePlanned\(planReads\(r\), declared\)/);
    expect(validate).toMatch(/readParts\(r, wanted, PART_LIMITS\)/);
    expect(validate).toMatch(/checkImageSize\(type, r, head\)/);
    expect(readFileSync(`${ROOT}${GUEST_DROP}cfb.ts`, "utf8")).toMatch(/\+\+reads > CFB_LIMITS\.maxSectorReads/);
    expect(readFileSync(`${ROOT}${GUEST_DROP}image.ts`, "utf8")).toMatch(/\+\+reads > limits\.maxReads/);
  });
});
