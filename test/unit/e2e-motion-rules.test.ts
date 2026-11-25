import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../e2e/", import.meta.url));

/** Each box a coordinate click is computed from, read before any atRest() in the same test. */
function unsettled(body: string): string[] {
  const late: string[] = [];
  for (const click of body.matchAll(/mouse\.click\(([^;]*)\);/g)) {
    for (const name of new Set((click[1] ?? "").match(/[A-Za-z_]\w*(?=\?\.|\.)/g) ?? [])) {
      const read = body.search(new RegExp(`const ${name} = await [^;]*boundingBox\\(\\)`));
      if (read < 0) continue;
      const settled = body.indexOf("atRest(");
      if (settled < 0 || settled > read) late.push(name);
    }
  }
  return late;
}

describe("e2e clicks at coordinates", () => {
  it("the check sees a box read before atRest, and passes one read after it", () => {
    const early = "const top = await sheet.boundingBox();\nawait page.mouse.click(top?.x ?? 0, (top?.y ?? 0) + 4);";
    expect(unsettled(early)).toEqual(["top"]);
    expect(unsettled(`await atRest(sheet);\n${early}`)).toEqual([]);
    expect(unsettled("await page.mouse.click(SCREEN.width / 2, 80);")).toEqual([]);
  });

  it("each box a click is computed from is read at rest: an entry animation moves it until it ends", () => {
    const missing: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".spec.ts"))) {
      for (const test of readFileSync(`${DIR}${file}`, "utf8")
        .split(/\n\s*test\(/)
        .slice(1)) {
        const body = test.split(/\n\s*test(?:\.describe)?\(/)[0] ?? "";
        for (const name of unsettled(body)) missing.push(`${file}: ${body.slice(1, 80)} (${name})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
