import { execFileSync } from "node:child_process";
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
// Tracked plus untracked-not-ignored: a gitignored local file (tasks/, CLAUDE.md) must not make a path pass here and fail in CI.
const REPO_FILES = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

/** Removes `//` and block comments from JSONC, leaving string contents (URLs hold `//`) alone. */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const CODE_EXT = "md|ts|js|mjs|json|jsonc|html|css|sql|py|yml|yaml|txt|example|bin|woff2|glb|svg";

describe("doc paths", () => {
  // Backticked names that look like paths but are not repo files: local-only files, the private venture
  // folder's files, the house design system, paths inside a zip, a placeholder domain.
  const NOT_IN_REPO = new Set([
    ".dev.vars",
    ".wrangler/state",
    "tasks/todo.md",
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
    return Object.keys(JSON.parse(stripJsonComments(read("wrangler.jsonc"))).vars);
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
  it("SITE-05 deps: package.json dependencies equal the list in ADR 0001", () => {
    const marked = read("docs/adr/0001-stack.md").match(/<!-- runtime-deps -->(.*?)<!-- \/runtime-deps -->/s)?.[1];
    const listed = [...(marked ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").sort();
    expect(listed.length).toBeGreaterThan(0);
    const actual = Object.keys(JSON.parse(read("package.json")).dependencies).sort();
    // A new dependency needs an ADR 0001 line (why, what it replaces, how to remove it); a removed one, its deletion.
    expect(actual).toEqual(listed);
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
    const entries: { name: string; path: string | string[] }[] = JSON.parse(read("package.json"))["size-limit"];
    expect(entries.length).toBeGreaterThan(5);
    // An entry is named by its title or by the file it measures (globs and exclusions name no single file).
    const terms = entries.flatMap((e) => [
      e.name,
      ...[e.path].flat().flatMap((p) => (/[*!]/.test(p) ? [] : [p.slice(p.lastIndexOf("/") + 1)])),
    ]);
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = terms.map(
      (t) => new RegExp(`${/^\w/.test(t) ? "\\b" : ""}${escapeRegExp(t)}${/\w$/.test(t) ? "\\b" : ""}`, "i"),
    );
    const restated: string[] = [];
    for (const doc of DOCS) {
      read(doc)
        .split("\n")
        .forEach((line, i) => {
          const sized = /\b\d+(\.\d+)?\s?(kB|KB|kb)\b/.test(line);
          if (sized && named.some((re) => re.test(line))) restated.push(`${doc}:${i + 1}`);
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
    const mitigated = rows
      .filter((cells) => /^mitigated\b/.test(cells[cells.length - 2] ?? ""))
      .map((cells) => cells[1] ?? "");
    expect(mitigated.length).toBeGreaterThan(20);

    const titles = walk("test", (path) => /\.(test|spec)\.ts$/.test(path))
      .flatMap((path) => read(path).match(/\b(?:it|describe|test)(?:\.\w+)?\(\s*["'`][^"'`]*/g) ?? [])
      .join("\n");
    const untested = mitigated.filter((id) => !titles.includes(id));
    expect(untested, "mitigated rows with no test title containing their id").toEqual([]);
  });
});
