import { describe, expect, it } from "vitest";
import { blocks, classify, depsChanged } from "../../tools/change-tier.mjs";

type Status = "A" | "M" | "D" | "T";
const file = (path: string, lines = 5, status: Status = "M") => ({ path, status, added: lines, deleted: 0 });
const SAME = { before: { zod: "4.6.7" }, after: { zod: "4.6.7" } };
const ADDED_DEP = { before: { zod: "4.6.7" }, after: { zod: "4.6.7", left: "1.0.0" } };

describe("classify", () => {
  it("T0: docs or tests only and under 40 lines", () => {
    expect(classify([file("docs/design.md", 20), file("test/unit/a.test.ts", 19)], SAME).tier).toBe(0);
    expect(classify([file("README.md", 3)], SAME).tier).toBe(0);
  });

  it("an empty diff is T0", () => {
    expect(classify([], SAME).tier).toBe(0);
  });

  it("T0 ends at 40 lines: docs only at 40 is T1", () => {
    expect(classify([file("docs/design.md", 39)], SAME).tier).toBe(0);
    expect(classify([file("docs/design.md", 40)], SAME).tier).toBe(1);
  });

  it("T1 is the default, and any source file keeps a small change out of T0", () => {
    expect(classify([file("src/worker/http.ts", 3)], SAME).tier).toBe(1);
    expect(classify([file("docs/design.md", 3), file("public/js/phone.js", 3)], SAME).tier).toBe(1);
  });

  it("T1 up to 400 lines, T2 above", () => {
    expect(classify([file("src/worker/machine.ts", 400)], SAME).tier).toBe(1);
    expect(classify([file("src/worker/machine.ts", 401)], SAME).tier).toBe(2);
  });

  it("counts added and deleted lines together", () => {
    const f = { path: "src/worker/machine.ts", status: "M" as const, added: 250, deleted: 200 };
    expect(classify([f], SAME).tier).toBe(2);
  });

  it("T2: dependencies change", () => {
    const tier = classify([file("package.json", 2)], ADDED_DEP);
    expect(tier.tier).toBe(2);
    expect(tier.reasons).toContain("dependencies changed");
    expect(classify([file("package.json", 2)], SAME).tier).toBe(1);
  });

  it("T2: a new file under src/worker/seams/, but not an edit to one", () => {
    expect(classify([file("src/worker/seams/pairing/index.ts", 5, "A")], SAME).tier).toBe(2);
    expect(classify([file("src/worker/seams/guest-drop/zip.ts", 5)], SAME).tier).toBe(1);
  });

  it("T2: a new migration, but not an edit or a delete", () => {
    expect(classify([file("migrations/0002_x.sql", 5, "A")], SAME).tier).toBe(2);
    expect(classify([file("migrations/0001_init.sql", 5, "D")], SAME).tier).toBe(1);
  });

  it("T2: header policy, static headers and auth code", () => {
    for (const path of [
      "src/worker/headers.ts",
      "src/worker/seams/open-path/headers.ts",
      "public/_headers",
      "src/worker/auth/vault.ts",
      "src/worker/routes/auth.ts",
    ]) {
      expect(classify([file(path, 1)], SAME).tier, path).toBe(2);
    }
    expect(classify([file("src/worker/routes/files.ts", 1)], SAME).tier).toBe(1);
  });

  it("T2 outranks T0: a tiny docs change beside a dependency change", () => {
    expect(classify([file("docs/design.md", 1), file("package.json", 1)], ADDED_DEP).tier).toBe(2);
  });

  it("names the gates of each tier", () => {
    expect(classify([file("docs/a.md", 1)], SAME).gates).toEqual(["npm run check"]);
    expect(classify([file("src/worker/http.ts", 1)], SAME).gates.join(" ")).toContain("code-review low");
    const t2 = classify([file("src/worker/headers.ts", 1)], SAME).gates.join(" ");
    expect(t2).toContain("/code-review high");
    expect(t2).toContain("/security-review");
  });
});

describe("depsChanged", () => {
  it("ignores key order, sees a version bump, a removal and a missing side", () => {
    expect(depsChanged({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(false);
    expect(depsChanged({ a: "1" }, { a: "2" })).toBe(true);
    expect(depsChanged({ a: "1" }, {})).toBe(true);
    expect(depsChanged(undefined, {})).toBe(false);
  });
});

describe("blocks", () => {
  it("blocks a dependency change with no ADR staged", () => {
    const out = blocks([file("package.json", 2), file("test/unit/a.test.ts")], ADDED_DEP, "add left");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("docs/adr/");
  });

  it("allows a dependency change with an ADR staged", () => {
    expect(blocks([file("package.json", 2), file("docs/adr/0009-x.md", 5, "A")], ADDED_DEP, "add left")).toEqual([]);
  });

  it("does not block a docs-only ADR edit or an unchanged dependency list", () => {
    expect(blocks([file("package.json", 2)], SAME, "bump scripts")).toEqual([]);
  });

  it("blocks src/ with neither docs/ nor test/ staged", () => {
    const out = blocks([file("src/worker/http.ts")], SAME, "tweak");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Docs: none needed");
  });

  it("allows src/ beside a test or a doc", () => {
    expect(blocks([file("src/worker/http.ts"), file("test/unit/http.test.ts")], SAME, "tweak")).toEqual([]);
    expect(blocks([file("src/worker/http.ts"), file("docs/architecture.md")], SAME, "tweak")).toEqual([]);
  });

  it("the trailer bypasses the src/ block, only as a whole line outside comments", () => {
    const src = [file("src/worker/http.ts")];
    expect(blocks(src, SAME, "tweak\n\nDocs: none needed\n")).toEqual([]);
    expect(blocks(src, SAME, "tweak\n\nDocs: none needed\nClaude-Session: x\n")).toEqual([]);
    expect(blocks(src, SAME, "tweak, Docs: none needed")).toHaveLength(1);
    expect(blocks(src, SAME, "tweak\n# Docs: none needed\n")).toHaveLength(1);
  });

  it("the trailer does not bypass the ADR block", () => {
    const out = blocks([file("package.json", 2)], ADDED_DEP, "add left\n\nDocs: none needed\n");
    expect(out).toHaveLength(1);
  });

  it("reports both blocks at once", () => {
    expect(blocks([file("package.json", 2), file("src/worker/http.ts")], ADDED_DEP, "x")).toHaveLength(2);
  });
});
