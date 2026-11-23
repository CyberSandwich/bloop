import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERRORS } from "../../public/js/shared/errors.js";
import { CONFIG_VARS } from "../../src/worker/config.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const UNTRACKED = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "coverage",
  "test-results",
  "playwright-report",
  ".lighthouseci",
]);

function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (UNTRACKED.has(name)) continue;
    const path = dir === "." ? name : `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}

// CLAUDE.md is gitignored, so it exists locally only.
const DOCS = [
  ...walk("docs", (path) => path.endsWith(".md")),
  ...(existsSync(join(ROOT, "CLAUDE.md")) ? ["CLAUDE.md"] : []),
];
const REPO_FILES = [...walk(".", () => true)];

const CODE_EXT = "md|ts|js|mjs|json|jsonc|html|css|sql|py|yml|yaml|txt|example|bin|woff2|glb|svg";

describe("doc paths", () => {
  // Backticked names that look like paths but are not repo files: local-only files, the private venture
  // folder's files, the house design system, paths inside a zip, a placeholder domain.
  const NOT_IN_REPO = new Set([
    ".dev.vars",
    ".wrangler/state",
    "product.md",
    "decisions.md",
    "tokens.css",
    "references/ai-tells.md",
    "ppt/presentation.xml",
    "vbaProject.bin",
    "bloop.example",
  ]);

  it("every repo path in backticks exists", () => {
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const [, span] of read(doc).matchAll(/`([^`\n]+)`/g)) {
        const ref = (span ?? "")
          .replace(/:\d+(-\d+)?$/, "")
          .replace(/^\.\//, "")
          .replace(/\/$/, "");
        // Skipped: URLs, routes, parent-folder (private) paths, assignments, npm scopes, home paths, MIME types, globs.
        if (/^(https?:|\/|\.\.\/|[A-Z_]+=|@|~|application\/)|[*<>{}()\s:|+]/.test(ref) || NOT_IN_REPO.has(ref))
          continue;
        const shaped = ref.includes("/") || new RegExp(`^[\\w.-]+\\.(${CODE_EXT})$`).test(ref);
        if (!shaped) continue;
        const dir = doc.includes("/") ? doc.slice(0, doc.lastIndexOf("/")) : "";
        const found = REPO_FILES.some(
          (file) => file === ref || file === join(dir, ref) || file.startsWith(`${ref}/`) || file.endsWith(`/${ref}`),
        );
        if (!found) missing.push(`${doc}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("architecture layout", () => {
  it("every file the layout block names exists", () => {
    const section = read("docs/architecture.md").split("## 5. Repo layout")[1] ?? "";
    const block = section.split("```")[1] ?? "";
    const names = block
      .split(/\s+/)
      .map((token) => token.replace(/^[(,]+|[),;.]+$/g, ""))
      // `a/{b,c}.ext` names several files.
      .flatMap((token) => {
        const group = token.match(/^(.*)\{([^}]+)\}(.*)$/);
        return group ? (group[2] ?? "").split(",").map((part) => `${group[1]}${part}${group[3]}`) : [token];
      })
      .filter((token) => new RegExp(`^[\\w./-]*\\.(${CODE_EXT})$`).test(token) && !token.includes("{"));
    expect(names.length).toBeGreaterThan(40);
    const missing = names.filter((name) => !REPO_FILES.some((file) => file === name || file.endsWith(`/${name}`)));
    expect(missing).toEqual([]);
  });
});

describe("worker vars", () => {
  const schemaKeys = Object.keys(CONFIG_VARS);
  const varKeys = (() => {
    const jsonc = read("wrangler.jsonc")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    return Object.keys(JSON.parse(jsonc).vars);
  })();
  const devVarKeys = read(".dev.vars.example")
    .split("\n")
    .flatMap((line) => line.match(/^([A-Z0-9_]+)=/)?.[1] ?? []);
  // Read by a module that is not built yet (ADR 0008), so config.ts does not parse it.
  const UNPARSED = new Set(["ROOM_ENROLL_KEY"]);

  it("wrangler.jsonc vars are all parsed by config.ts", () => {
    expect(varKeys.filter((key) => !schemaKeys.includes(key))).toEqual([]);
  });

  it("every other config.ts variable is a secret in .dev.vars.example, or TEST_TIMING", () => {
    const rest = schemaKeys.filter((key) => !varKeys.includes(key) && !devVarKeys.includes(key));
    expect(rest).toEqual(["TEST_TIMING"]);
  });

  it(".dev.vars.example sets only variables config.ts parses", () => {
    expect(devVarKeys.filter((key) => !schemaKeys.includes(key) && !UNPARSED.has(key))).toEqual([]);
  });

  it("every variable carries its meaning in a describe()", () => {
    const bare = Object.entries(CONFIG_VARS).flatMap(([key, type]) => (type.description ? [] : [key]));
    expect(bare).toEqual([]);
  });

  it("docs do not list the variables: architecture.md names no key=value line", () => {
    const listed = read("docs/architecture.md")
      .split("\n")
      .filter((line) => /^[A-Z][A-Z0-9_]+=/.test(line));
    expect(listed).toEqual([]);
  });
});

describe("design tokens", () => {
  const norm = (value: string) =>
    value
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/(?<!\d)0\./g, ".");

  it("every `--token:value` in design.md section 4 is in app.css :root with the same value", () => {
    const section = read("docs/design.md").split("\n## 4. ")[1]?.split("\n## ")[0] ?? "";
    const documented = [...section.matchAll(/`(--[\w-]+):([^`]+)`/g)].map((m) => [m[1] ?? "", m[2] ?? ""] as const);
    expect(documented.length).toBeGreaterThan(8);

    const rootBlock = read("public/css/app.css").match(/^:root\s*\{([^}]*)\}/m)?.[1] ?? "";
    const css = new Map([...rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
    const drift = documented
      .filter(([name, value]) => norm(css.get(name) ?? "<missing>") !== norm(value))
      .map(([name, value]) => `${name}: design.md ${value}, app.css ${css.get(name) ?? "missing"}`);
    expect(drift).toEqual([]);

    const named = new Set([...section.matchAll(/`(--[\w-]+)(?::[^`]*)?`/g)].map((m) => m[1] ?? ""));
    // Named only to say bloop does not use them (the "Status colors" row).
    const unused = new Set(["--ok", "--warn", "--err"]);
    expect([...named].filter((name) => !css.has(name) && !unused.has(name))).toEqual([]);
  });
});

describe("dependency budget", () => {
  it("package.json dependencies are a subset of the list in ADR 0001", () => {
    const marked = read("docs/adr/0001-stack.md").match(/<!-- runtime-deps -->(.*?)<!-- \/runtime-deps -->/s)?.[1];
    const allowed = [...(marked ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(allowed.length).toBeGreaterThan(0);
    const extra = Object.keys(JSON.parse(read("package.json")).dependencies).filter((name) => !allowed.includes(name));
    expect(extra, "add an ADR 0001 line (why, what it replaces, how to remove it) before a new dependency").toEqual([]);
  });
});

describe("doc size", () => {
  const WARN_LINES = 400;
  const FAIL_LINES = 800;

  it(`warns above ${WARN_LINES} lines per doc and fails above ${FAIL_LINES}`, () => {
    const oversized: string[] = [];
    for (const doc of DOCS) {
      const lines = read(doc).split("\n").length;
      if (lines > FAIL_LINES) oversized.push(`${doc}: ${lines} lines`);
      else if (lines > WARN_LINES)
        console.warn(`${doc} has ${lines} lines (over ${WARN_LINES}): consider splitting it`);
    }
    expect(oversized, `split these docs (limit ${FAIL_LINES} lines)`).toEqual([]);
  });
});

describe("error table", () => {
  it("interfaces.md section 8 points at errors.js and restates no code", () => {
    const section = read("docs/interfaces.md").split("## 8. ")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("public/js/shared/errors.js");
    expect(Object.keys(ERRORS).filter((code) => new RegExp(`\\b${code}\\b`).test(section))).toEqual([]);
  });
});

describe("size budgets", () => {
  it("only package.json size-limit states a budget: docs name no entry next to a size", () => {
    const entries: { name: string }[] = JSON.parse(read("package.json"))["size-limit"];
    expect(entries.length).toBeGreaterThan(5);
    const restated: string[] = [];
    for (const doc of DOCS) {
      read(doc)
        .split("\n")
        .forEach((line, i) => {
          const sized = /\b\d+(\.\d+)?\s?(kB|KB|kb)\b/.test(line);
          const named = entries.some((e) => new RegExp(`\\b${e.name.replace(/[()]/g, "\\$&")}\\b`, "i").test(line));
          if (sized && named) restated.push(`${doc}:${i + 1}`);
        });
    }
    expect(restated).toEqual([]);
  });
});

describe("threat model", () => {
  it("every mitigated row has its id in a test title", () => {
    const rows = read("docs/threat-model.md")
      .split("\n")
      .filter((line) => /^\| [A-Z]+-\d+ \|/.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const mitigated = rows.filter((cells) => cells[cells.length - 2] === "mitigated").map((cells) => cells[1] ?? "");
    expect(mitigated.length).toBeGreaterThan(20);

    const titles = walk("test", (path) => /\.(test|spec)\.ts$/.test(path))
      .flatMap((path) => read(path).match(/\b(?:it|describe|test)(?:\.\w+)?\(\s*["'`][^"'`]*/g) ?? [])
      .join("\n");
    const untested = mitigated.filter((id) => !titles.includes(id));
    expect(untested, "mitigated rows with no test title containing their id").toEqual([]);
  });
});
