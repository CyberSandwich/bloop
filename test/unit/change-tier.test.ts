import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blocks,
  classify,
  dependencySections,
  depsAround,
  depsChanged,
  offRegistry,
  parseDiff,
  registryRange,
} from "../../tools/change-tier.mjs";
import { SPAWN_TIMEOUT } from "./spawn.ts";

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
    expect(tier.reasons).toContain("package.json dependency sections changed");
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

  it("T2: a Durable Object schema file, whatever its status, but not other files in do/", () => {
    for (const path of ["src/worker/do/schema.ts", "src/worker/do/directory-schema.ts"]) {
      const tier = classify([file(path, 3)], SAME);
      expect(tier.tier, path).toBe(2);
      expect(tier.reasons[0]).toContain("Durable Object schema step");
    }
    expect(classify([file("src/worker/do/future-schema.ts", 3, "A")], SAME).tier).toBe(2);
    expect(classify([file("src/worker/do/rooms/rooms-schema.ts", 3, "A")], SAME).tier).toBe(2);
    expect(classify([file("src/worker/spend/schema.ts", 3)], SAME).tier).toBe(2);
    expect(classify([file("src/worker/spend/meters.ts", 3)], SAME).tier).toBe(1);
    expect(classify([file("src/worker/do/directory.ts", 3)], SAME).tier).toBe(1);
    expect(classify([file("test/unit/directory-schema.test.ts", 3)], SAME).tier).toBe(0);
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

  it("a new devDependency is T2 and needs an ADR like a dependency", () => {
    const after = dependencySections('{"dependencies":{"zod":"1"},"devDependencies":{"vitest":"1","left":"1"}}');
    expect(classify([file("package.json", 2)], { before, after }).tier).toBe(2);
    expect(blocks([file("package.json", 2)], { before, after }, "add left")).toHaveLength(1);
    expect(
      blocks([file("package.json", 2), file("docs/adr/0009-x.md", 5, "A")], { before, after }, "add left"),
    ).toEqual([]);
  });

  it("a version-only bump of a kept package is T2 but needs no ADR", () => {
    const after = dependencySections('{"dependencies":{"zod":"^1.2"},"devDependencies":{"vitest":"2.0.0-beta.1"}}');
    expect(classify([file("package.json", 2)], { before, after }).tier).toBe(2);
    expect(blocks([file("package.json", 2)], { before, after }, "bump")).toEqual([]);
  });

  it("a removed package needs an ADR", () => {
    const after = dependencySections('{"dependencies":{"zod":"1"},"devDependencies":{}}');
    expect(blocks([file("package.json", 2)], { before, after }, "drop vitest")).toHaveLength(1);
  });

  it("only a registry range on both sides counts as a version bump", () => {
    const ranges = ["1", "^1.2.3", "~1.2", ">=1.0.0 <2", "1.x", "*", "1.2.3 - 2", "^1 || ^2", "2.0.0-beta.1+b.7", "v1"];
    for (const spec of ranges) expect(registryRange(spec), spec).toBe(true);
    const others = [
      "x.tgz",
      "x.tar",
      "x.tar.gz",
      "1.0.0-x.tgz",
      "..",
      ".",
      "~/x",
      "workspace:*",
      "link:x",
      "latest",
      "",
    ];
    for (const spec of others) expect(registryRange(spec), spec).toBe(false);
  });

  it("a spec that swaps the source under a kept name needs an ADR, either way round", () => {
    const specs = ["npm:other@1", "git+https://example.test/x.git", "file:../x", "user/repo", "x.tgz", "x.tar"];
    for (const spec of [...specs, "..", ".", "~/x", "workspace:*", "link:x", "1.0.0-x.tgz", "latest"]) {
      const after = dependencySections(`{"dependencies":{"zod":"${spec}"},"devDependencies":{"vitest":"1"}}`);
      expect(blocks([file("package.json", 2)], { before, after }, "swap"), spec).toHaveLength(1);
      expect(blocks([file("package.json", 2)], { before: after, after: before }, "swap back"), spec).toHaveLength(1);
    }
  });

  it("moving a package between the sections counts, and needs an ADR", () => {
    const after = dependencySections('{"dependencies":{"zod":"1","vitest":"1"},"devDependencies":{}}');
    expect(depsChanged(before, after)).toBe(true);
    expect(blocks([file("package.json", 2)], { before, after }, "move")).toHaveLength(1);
  });

  it("optional, peer and bundled dependencies, overrides and resolutions all count", () => {
    const base = '"dependencies":{"zod":"1"},"devDependencies":{"vitest":"1"}';
    const changed = [
      '"optionalDependencies":{"left":"1"}',
      '"peerDependencies":{"left":"1"}',
      '"bundleDependencies":["zod"]',
      '"bundledDependencies":true',
      '"overrides":{"zod":"npm:evil@1"}',
      '"resolutions":{"zod":"1"}',
    ];
    for (const extra of changed) {
      const after = dependencySections(`{${base},${extra}}`);
      expect(classify([file("package.json", 2)], { before, after }).tier, extra).toBe(2);
      expect(blocks([file("package.json", 2)], { before, after }, "x"), extra).toHaveLength(1);
    }
    const nested = (spec: string) => dependencySections(`{${base},"overrides":{"zod":{"left":"${spec}"}}}`);
    expect(blocks([file("package.json", 2)], { before: nested("1"), after: nested("2") }, "x")).toHaveLength(1);
  });

  it("a deleted ADR file does not satisfy the ADR rule", () => {
    const after = dependencySections('{"dependencies":{"zod":"1"},"devDependencies":{}}');
    expect(blocks([file("package.json", 2), file("docs/adr/0009-x.md", 5, "D")], { before, after }, "x")).toHaveLength(
      1,
    );
    expect(blocks([file("package.json", 2), file("docs/adr/0001-x.md", 1)], { before, after }, "x")).toEqual([]);
  });

  it("scripts-only edits to package.json change nothing", () => {
    const after = dependencySections(
      '{"scripts":{"x":"y"},"dependencies":{"zod":"1"},"devDependencies":{"vitest":"1"}}',
    );
    expect(depsChanged(before, after)).toBe(false);
  });
});

describe("lockfile sources", () => {
  const lock = (entries: Record<string, string | undefined>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(Object.entries(entries).map(([k, resolved]) => [k, { version: "1", resolved }])),
    });
  const REG = "https://registry.npmjs.org/zod/-/zod-1.tgz";

  it("lists every entry resolved off the npm registry, v1 nested entries included", () => {
    expect(offRegistry(lock({ "": undefined, "node_modules/zod": REG }))).toEqual([]);
    const bad = lock({
      "node_modules/a": "https://evil.example/a-1.tgz",
      "node_modules/b": "http://registry.npmjs.org/b/-/b-1.tgz",
      "node_modules/c": "git+ssh://git@example.test/c.git#abc",
      "node_modules/d": "https://registry.npmjs.org.evil.example/d-1.tgz",
      "node_modules/e": "not a url",
    });
    expect(offRegistry(bad)).toHaveLength(5);
    const v1 = {
      lockfileVersion: 1,
      dependencies: { a: { resolved: REG, dependencies: { b: { resolved: "file:b" } } } },
    };
    expect(offRegistry(JSON.stringify(v1))).toEqual(["a>b file:b"]);
  });

  it("blocks only an off-registry entry the change brings in", () => {
    const old = offRegistry(lock({ "node_modules/a": "https://evil.example/a-1.tgz" }));
    const now = offRegistry(
      lock({ "node_modules/a": "https://evil.example/a-1.tgz", "node_modules/zod": "https://evil.example/zod.tgz" }),
    );
    const out = blocks([file("package-lock.json", 2)], { ...SAME, lockBefore: old, lockAfter: now }, "bump");
    expect(out).toEqual([
      "package-lock.json resolves node_modules/zod https://evil.example/zod.tgz: only https://registry.npmjs.org is allowed.",
    ]);
    expect(blocks([file("package-lock.json", 2)], { ...SAME, lockBefore: old, lockAfter: old }, "x")).toEqual([]);
  });

  it("depsAround reads a missing or broken file as none", () => {
    const files: Record<string, string> = { "a:package.json": '{"dependencies":{"zod":"1"}}', "b:package.json": "{" };
    const show = (spec: string) => {
      const text = files[spec];
      if (text === undefined) throw new Error("missing");
      return text;
    };
    expect(depsAround(show, "a:", "b:")).toEqual({
      before: { "dependencies:zod": "1" },
      after: undefined,
      lockBefore: [],
      lockAfter: [],
    });
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

describe("the CLI against a real repository", { timeout: SPAWN_TIMEOUT }, () => {
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

      // The commit-msg hook refuses attribution before the commit exists, so a land never rewrites history.
      writeFileSync(msg, "change\n\nDocs: none needed\n\nClaude-Session: https://example.test/s\n");
      const attributed = run(dir, TOOL, "--msg-file", msg);
      expect(attributed.status).toBe(1);
      expect(attributed.stderr).toContain("AI attribution");
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
    expect(blocks(src, SAME, "tweak\n\nDocs: none needed\nRefs: x\n")).toEqual([]);
    expect(blocks(src, SAME, "tweak, Docs: none needed")).toHaveLength(1);
    expect(blocks(src, SAME, "tweak\n# Docs: none needed\n")).toHaveLength(1);
  });

  it("the trailer does not bypass the ADR block", () => {
    const out = blocks([file("package.json", 2)], ADDED_DEP, "add left\n\nDocs: none needed\n");
    expect(out).toHaveLength(1);
  });

  it("reports every block at once", () => {
    expect(blocks([file("package.json", 2), file("src/worker/http.ts")], ADDED_DEP, "x")).toHaveLength(2);
    expect(blocks([file("src/worker/http.ts")], ADDED_DEP, "x\n\nCo-Authored-By: A <a@example.test>")).toHaveLength(3);
  });

  it("blocks AI attribution in any change, outside git's comment lines only", () => {
    const docs = [file("docs/architecture.md")];
    for (const line of [
      "Co-Authored-By: A <a@example.test>",
      "Claude-Session: https://example.test/s",
      "Generated with [Claude Code](https://example.test)",
    ]) {
      const out = blocks(docs, SAME, `tweak\n\n${line}\n`);
      expect(out, line).toHaveLength(1);
      expect(out[0]).toContain("AI attribution");
    }
    expect(blocks(docs, SAME, "tweak\r\n\r\nClaude-Session: x\r\n")).toHaveLength(1);
    expect(blocks(docs, SAME, "tweak\n# Co-Authored-By: a template comment\n")).toEqual([]);
    expect(blocks(docs, SAME, "Update the CLAUDE.md pointer")).toEqual([]);
  });

  it("reads the message only above `commit -v`'s scissors line, where the staged diff begins", () => {
    const scissors = "# ------------------------ >8 ------------------------";
    const diff = "+    expect(attributed('x\\n\\nCo-Authored-By: A')).toBe(true);\nCo-Authored-By: in the diff text\n";
    expect(
      blocks([file("docs/architecture.md")], SAME, `tweak\n\n${scissors}\n# Do not modify this line.\n${diff}`),
    ).toEqual([]);
    expect(
      blocks([file("docs/architecture.md")], SAME, `tweak\n\nClaude-Session: x\n${scissors}\n${diff}`),
    ).toHaveLength(1);
    // The src/ trailer below the scissors is diff text, not the message's.
    expect(blocks([file("src/worker/http.ts")], SAME, `tweak\n${scissors}\nDocs: none needed\n`)).toHaveLength(1);
  });
});
