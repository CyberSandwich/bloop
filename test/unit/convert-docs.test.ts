import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODES } from "../../src/worker/convert/codes.ts";

const doc = readFileSync(new URL("../../docs/conversion.md", import.meta.url), "utf8");
const section = doc.split("## 2. ")[1]?.split("\n## ")[0] ?? "";

/** The copy table's rows: the codes of the first cell, the message, the action. */
const rows = [...section.matchAll(/^\| ((?:`\w+`(?:, )?)+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => ({
  codes: [...(m[1] ?? "").matchAll(/`(\w+)`/g)].map((c) => c[1] as string),
  message: (m[2] ?? "").trim(),
  action: (m[3] ?? "").trim(),
}));

describe("conversion copy: every code has a message and an action", () => {
  it("lists exactly the codes a derived row can carry", () => {
    expect(rows.flatMap((r) => r.codes).sort()).toEqual([...CODES].sort());
  });

  it("gives each row words for a person and a way forward", () => {
    for (const r of rows) {
      expect(r.message.length, r.codes.join()).toBeGreaterThan(10);
      expect(r.action.length, r.codes.join()).toBeGreaterThan(3);
    }
  });

  it("uses no em or en dash", () => {
    expect(doc).not.toMatch(/[–—]/);
  });
});
