// Every platform rate-limit binding is stated once, in the architecture rate-limit table, as wrangler.jsonc declares
// it; every other doc points to the table instead of restating a number.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declaredRateLimits } from "../env-vars.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const TABLE_DOC = "docs/architecture.md";

/** The rows of the table under "### Rate limits", header and rule excluded; the table may end the file. */
function tableRows(doc: string): string[] {
  const at = doc.indexOf("\n### Rate limits\n");
  if (at < 0) return [];
  const lines = doc.slice(at).split("\n").slice(1);
  const start = lines.findIndex((l) => l.startsWith("|"));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith("|"));
  return lines.slice(start + 2, end < 0 ? lines.length : end);
}

interface Statement {
  name: string;
  limit: number;
  period: number | undefined;
}

const PERIOD = String.raw`(?:per (\d+) s|(a|per) minute)`;
/** A number tied to a binding within one clause: "N per P s ... `RL_X`" or "`RL_X` at N" (or "`RL_X`, N a minute"). */
const NUMBER_FIRST = new RegExp(String.raw`(\d+) ${PERIOD}\b[^|;.]*?\x60(RL_[A-Z_]+)\x60`, "g");
const NAME_FIRST = new RegExp(String.raw`\x60?(RL_[A-Z_]+)\x60?(?: at|,) (\d+)\b(?: ${PERIOD})?`, "g");

function statements(text: string): Statement[] {
  const period = (seconds?: string, minute?: string) => (seconds ? Number(seconds) : minute ? 60 : undefined);
  return [
    ...[...text.matchAll(NUMBER_FIRST)].map((m) => ({
      name: m[4] ?? "",
      limit: Number(m[1]),
      period: period(m[2], m[3]),
    })),
    ...[...text.matchAll(NAME_FIRST)].map((m) => ({
      name: m[1] ?? "",
      limit: Number(m[2]),
      period: period(m[3], m[4]),
    })),
  ];
}

function docs(dir = "docs"): string[] {
  return readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? docs(`${dir}/${e.name}`) : e.name.endsWith(".md") ? [`${dir}/${e.name}`] : [],
  );
}

describe("rate limits: the architecture table states every declared binding", () => {
  it("AUTH-19 meter: each declared binding is stated in exactly one row, with its declared limit and period", () => {
    const bindings = declaredRateLimits();
    expect(Object.keys(bindings).length).toBeGreaterThanOrEqual(20);
    const rows = tableRows(read(TABLE_DOC));
    for (const [name, want] of Object.entries(bindings)) {
      const stating = rows.filter((row) => statements(row).some((s) => s.name === name));
      expect(stating, name).toHaveLength(1);
      for (const s of statements(stating[0] ?? "").filter((s) => s.name === name)) {
        expect(s.limit, name).toBe(want.limit);
        expect(s.period ?? want.period, name).toBe(want.period);
      }
    }
  });

  it("AUTH-19 meter: the table names no binding wrangler.jsonc does not declare", () => {
    const bindings = declaredRateLimits();
    const named = tableRows(read(TABLE_DOC)).flatMap((row) => [...row.matchAll(/`(RL_[A-Z_]+)`/g)].map((m) => m[1]));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !(name && name in bindings))).toEqual([]);
  });

  it("AUTH-19 meter: no doc outside the table restates a binding's number", () => {
    const restated = docs().flatMap((path) => {
      const text = read(path);
      const rows = path === TABLE_DOC ? new Set(tableRows(text)) : new Set<string>();
      return text
        .split("\n")
        .filter((line) => !rows.has(line))
        .flatMap((line) => statements(line).map((s) => `${path}: ${s.name} ${s.limit}`));
    });
    expect(restated).toEqual([]);
  });

  it("reads both statement forms, and a table that ends the file", () => {
    const doc =
      "x\n### Rate limits\n\n| where | limit |\n|---|---|\n| a | 5 per 60 s per IP (`RL_A`) |\n| b | `RL_B` at 100 |";
    expect(tableRows(doc)).toHaveLength(2);
    expect(tableRows(doc).flatMap(statements)).toEqual([
      { name: "RL_A", limit: 5, period: 60 },
      { name: "RL_B", limit: 100, period: undefined },
    ]);
    expect(statements("(`RL_CONTROL`, 120 a minute per IP)")).toEqual([{ name: "RL_CONTROL", limit: 120, period: 60 }]);
  });
});
