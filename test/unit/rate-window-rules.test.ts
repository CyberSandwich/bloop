import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../integration/", import.meta.url));
/** Bursts against a counter bloop keeps itself, whose window starts at the first hit rather than on the clock. */
const OWN_COUNTERS = [
  "PAIR-07 limits: the 11th miss gives 429", // the Directory's miss window
  "PC-02 sid-powers: each item gets its first link plus five more", // the machine's mint count
];

describe("integration bursts against a platform rate limit", () => {
  it("each one starts with inOneWindow(), since the local binding's window follows the wall clock", () => {
    const missing: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".test.ts"))) {
      for (const test of readFileSync(`${DIR}${file}`, "utf8")
        .split(/\n\s*it\(/)
        .slice(1)) {
        const body = test.split(/\n\s*(?:it|describe)\(/)[0] ?? "";
        const title = body.slice(1, body.indexOf('"', 1));
        if (!/for \(/.test(body) || !/429|rate_limited/.test(body) || /inOneWindow\(/.test(body)) continue;
        if (!OWN_COUNTERS.some((t) => title.startsWith(t))) missing.push(`${file}: ${title}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
