import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blocks, classify, dependencySections, depsChanged, parseDiff } from "../../tools/change-tier.mjs";

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
    expect(tier.reasons).toContain("dependencies or devDependencies changed");
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

  it("T2: a Durable Object schema file anywhere under src/worker", () => {
    for (const path of [
      "src/worker/spend/schema.ts",
      "src/worker/do/screen-schema.ts",
      "src/worker/do/schema/library-schema.ts",
    ]) {
      expect(classify([file(path, 1)], SAME).tier, path).toBe(2);
    }
    expect(classify([file("src/worker/spend/meters.ts", 1)], SAME).tier).toBe(1);
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

describe("dev dependencies", () => {
  const before = dependencySections('{"dependencies":{"zod":"1"},"devDependencies":{"vitest":"1"}}');

  it("a new or bumped devDependency is T2 and needs an ADR like a dependency", () => {
    const after = dependencySections('{"dependencies":{"zod":"1"},"devDependencies":{"vitest":"2"}}');
    expect(classify([file("package.json", 2)], { before, after }).tier).toBe(2);
    expect(blocks([file("package.json", 2)], { before, after }, "bump")).toHaveLength(1);
    expect(blocks([file("package.json", 2), file("docs/adr/0009-x.md", 5, "A")], { before, after }, "bump")).toEqual(
      [],
    );
  });

  it("moving a package between the sections counts", () => {
    const after = dependencySections('{"dependencies":{"zod":"1","vitest":"1"},"devDependencies":{}}');
    expect(depsChanged(before, after)).toBe(true);
  });

  it("scripts-only edits to package.json change nothing", () => {
    const after = dependencySections(
      '{"scripts":{"x":"y"},"dependencies":{"zod":"1"},"devDependencies":{"vitest":"1"}}',
    );
    expect(depsChanged(before, after)).toBe(false);
  });
});

describe("parseDiff", () => {
  it("reads NUL-separated git output, non-ASCII paths included", () => {
    const numstat = "3\t1\tsrc/worker/auth/véri.ts\0-\t-\tpublic/robin.bin\0";
    const nameStatus = "M\0src/worker/auth/véri.ts\0A\0public/robin.bin\0";
    expect(parseDiff(numstat, nameStatus)).toEqual([
      { path: "src/worker/auth/véri.ts", status: "M", added: 3, deleted: 1 },
      { path: "public/robin.bin", status: "A", added: 0, deleted: 0 },
    ]);
    expect(parseDiff("", "")).toEqual([]);
  });
});

describe("the CLI against a real repository", () => {
  const TOOL = fileURLToPath(new URL("../../tools/change-tier.mjs", import.meta.url));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const run = (cwd: string, entry: string, ...args: string[]) =>
    spawnSync("node", [entry, "--staged", ...args], { cwd, encoding: "utf8" });

  it("classifies a staged non-ASCII auth path as T2, through a symlinked entry point", () => {
    const dir = mkdtempSync(join(tmpdir(), "tier-"));
    try {
      git(dir, "init", "-q");
      mkdirSync(join(dir, "src/worker/auth"), { recursive: true });
      writeFileSync(join(dir, "src/worker/auth/véri.ts"), "export {};\n");
      git(dir, "add", "--", "src/worker/auth/véri.ts");
      const link = join(dir, "link.mjs");
      symlinkSync(TOOL, link);

      const direct = run(dir, TOOL);
      expect(direct.stdout).toMatch(/^T2: auth code: src\/worker\/auth\/véri\.ts/);
      expect(run(dir, link).stdout).toBe(direct.stdout);

      const msg = join(dir, "msg");
      writeFileSync(msg, "change\n");
      const blocked = run(dir, TOOL, "--msg-file", msg);
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain("Docs: none needed");

      writeFileSync(msg, "change\r\n\r\nDocs: none needed\r\n");
      expect(run(dir, TOOL, "--msg-file", msg).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
