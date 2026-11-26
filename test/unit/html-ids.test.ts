// getElementById answers the first match, so a repeated id silently rewires a page's script to the wrong element.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PUBLIC = new URL("../../public/", import.meta.url);

describe("every page's ids are unique", () => {
  for (const file of readdirSync(PUBLIC).filter((f) => f.endsWith(".html"))) {
    it(`${file} repeats no id`, () => {
      const ids = [...readFileSync(new URL(file, PUBLIC), "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(repeated).toEqual([]);
    });
  }
});
