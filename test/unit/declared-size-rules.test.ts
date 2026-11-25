import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../src/worker/", import.meta.url).pathname;
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

/** The one use outside zip.ts: it bounds a read that is itself bounded by the real file size (zip.ts entryBytes). */
const ALLOWED = [{ file: "seams/guest-drop/validate.ts", line: "if (entry.compressed > cap) return null;" }];

describe("a declared size in an untrusted container is a claim, never a measure", () => {
  it("keeps the sizes a zip declares inside zip.ts, which refuses early and never budgets with them", () => {
    const uses = sources(ROOT)
      .filter((f) => !f.endsWith("seams/guest-drop/zip.ts"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .filter((l) => /\.(un)?compressed\b/.test(l))
          .map((l) => ({ file: f.slice(ROOT.length), line: l.trim() })),
      );
    expect(uses).toEqual(ALLOWED);
  });

  it("budgets by the length of what was read, as the relationships reader does", () => {
    const src = readFileSync(`${ROOT}seams/guest-drop/validate.ts`, "utf8");
    expect(src).toMatch(/budget -= bytes\.length/);
    expect(src).not.toMatch(/budget -= .*\.(un)?compressed/);
  });
});
