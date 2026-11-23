import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
