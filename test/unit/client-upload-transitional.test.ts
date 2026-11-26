// The upload client's integration test starts two servers of its own and waits out the end of a UTC day, until
// startWrangler takes a `limits` option. This pins the marker and the bound so neither outlives that change unseen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../integration/upload-client.test.ts", import.meta.url), "utf8");

describe("the upload client's transitional integration setup", () => {
  it("is marked, so it is found and removed when startWrangler takes limits", () => {
    expect(source.match(/transitional: A limits option/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("waits only inside the last 135 s of a UTC day, and never longer than that", () => {
    expect(source).toContain(
      "if (toMidnight() < 135_000) await new Promise((resolve) => setTimeout(resolve, toMidnight() + 1000));",
    );
  });
});
