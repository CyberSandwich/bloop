// Every user-facing limit is typed as a number in one place; every other place imports it or is checked against it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_PIXELS } from "../../src/shared/limits.ts";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const vars: Record<string, string> = wranglerConfig(read("wrangler.jsonc")).vars;

const SOURCES = ["src", "public/js", "tools", "container"]
  .flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" }).map((p) => `${dir}/${p}`))
  .filter(
    (p) =>
      /\.(ts|js|mjs|go)$/.test(p) && !/^(public\/js\/vendor|container\/fixtures)\//.test(p) && !p.endsWith("_test.go"),
  );

interface Fact {
  name: string;
  /** Where the number is typed; a `wrangler.jsonc` var is never scanned, the guard reads it. */
  owner: string;
  literal: RegExp;
  /** Copies the scan finds and accepts because a check below pins them to the owner. */
  mirrors?: string[];
  /** Restatements still waiting on their file's owner; the list must match the scan, so a fix fails here until its entry goes. */
  pending?: string[];
}

const FACTS: Fact[] = [
  {
    name: "image pixel cap",
    owner: "src/shared/limits.ts",
    literal: /\b100_?000_?000\b|\b1e8\b/,
    mirrors: ["container/main.go"],
  },
  {
    name: "R2 monthly operation caps",
    owner: "src/worker/seams/guest-drop/meter.ts",
    literal: /\b(500_?000|5_?000_?000)\b/,
    pending: ["src/worker/config/core.ts"],
  },
  {
    name: "items per session",
    owner: "src/worker/items.ts",
    literal: /\b(MAX_ITEMS|UP_NEXT_MAX)\s*=\s*\d/,
    pending: ["src/worker/library/store.ts"],
  },
  {
    name: "file name length",
    owner: "public/js/shared/file-name.js",
    literal: /\bNAME_MAX\s*=\s*\d/,
    pending: ["src/shared/name-rule.ts"],
  },
  {
    name: "pairing code lifetimes (CODE_TTL_SECONDS, CODE_GRACE_SECONDS)",
    owner: "wrangler.jsonc",
    literal: /\bCODE_(TTL|GRACE)_MS\s*=\s*\d/,
    pending: ["public/js/core/timing.js"],
  },
  {
    name: "guest object size (LIBRARY_MAX_FILE_BYTES)",
    owner: "wrangler.jsonc",
    literal: /\bMAX_OBJECT_BYTES\s*=\s*\d/,
    pending: ["src/worker/seams/guest-drop/validate.ts"],
  },
  {
    name: "phone size refusal (GUEST_MAX_BYTES)",
    owner: "wrangler.jsonc",
    literal: /\bmaxMB\s*\?\?\s*\d/,
    pending: ["public/js/core/copy-phone.js"],
  },
];

describe("single owner: each limit is typed once", () => {
  for (const fact of FACTS) {
    it(`${fact.name} is typed only in ${fact.owner}`, () => {
      const found = SOURCES.filter((p) => p !== fact.owner && fact.literal.test(read(p)));
      const allowed = [...(fact.mirrors ?? []), ...(fact.pending ?? [])];
      expect(found.sort()).toEqual(allowed.sort());
    });
  }

  it("the container's pixel cap default equals MAX_PIXELS", () => {
    const go = read("container/main.go").match(/"BLOOP_MAX_IMAGE_PIXELS",\s*([\d_]+)\)/);
    expect(Number(go?.[1]?.replaceAll("_", ""))).toBe(MAX_PIXELS);
  });

  it("the client's code timings equal production's while they are pending", async () => {
    const { CODE_TTL_MS, CODE_GRACE_MS } = await import("../../public/js/core/timing.js");
    expect(CODE_TTL_MS).toBe(Number(vars.CODE_TTL_SECONDS) * 1000);
    expect(CODE_GRACE_MS).toBe(Number(vars.CODE_GRACE_SECONDS) * 1000);
  });

  it("the Security page states the real upload link life", () => {
    const minutes = read("content/open/security.md").match(
      /link made for that one part, which expires after (\d+) minutes/,
    );
    expect(Number(minutes?.[1]) * 60).toBe(Number(vars.UPLOAD_URL_TTL_SECONDS));
  });
});
