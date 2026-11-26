// Every platform rate-limit binding is stated once, in the architecture rate-limit table, as wrangler.jsonc declares it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Each binding in wrangler.jsonc's `ratelimits`, with its limit and period. */
function declared(): Map<string, { limit: number; period: number }> {
  const all = read("wrangler.jsonc").matchAll(/"name": "(RL_[A-Z_]+)"[^}]*"limit": (\d+), "period": (\d+)/g);
  return new Map([...all].map((m) => [m[1] ?? "", { limit: Number(m[2]), period: Number(m[3]) }]));
}

/** The rows of the table under "### Rate limits", header and rule excluded. */
function tableRows(): string[] {
  const doc = read("docs/architecture.md");
  const section = doc.slice(doc.indexOf("\n### Rate limits\n"));
  const lines = section.split("\n").slice(1);
  const start = lines.findIndex((l) => l.startsWith("|"));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith("|"));
  return lines.slice(start + 2, end);
}

/** "N per P s ... (`RL_X`" within one clause: a stated limit and the binding it belongs to. */
const STATED = /(\d+) per (\d+) s\b[^|;]*?\(`(RL_[A-Z_]+)`/g;

describe("rate limits: the architecture table states every declared binding", () => {
  it("AUTH-19 meter: each declared binding is stated in exactly one row, with its declared limit and period", () => {
    const bindings = declared();
    expect(bindings.size).toBeGreaterThanOrEqual(20);
    const rows = tableRows();
    for (const [name, want] of bindings) {
      const stating = rows.filter((row) => [...row.matchAll(STATED)].some((m) => m[3] === name));
      expect(stating, name).toHaveLength(1);
      for (const m of (stating[0] ?? "").matchAll(STATED))
        if (m[3] === name) expect({ limit: Number(m[1]), period: Number(m[2]) }, name).toEqual(want);
    }
  });

  it("AUTH-19 meter: the table names no binding wrangler.jsonc does not declare", () => {
    const bindings = declared();
    const named = tableRows().flatMap((row) => [...row.matchAll(/`(RL_[A-Z_]+)`/g)].map((m) => m[1] ?? ""));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !bindings.has(name))).toEqual([]);
  });

  it("AUTH-19 meter: ADR 0014's member-limit line points to the table and restates no number", () => {
    const line = read("docs/adr/0014-sign-in.md")
      .split("\n")
      .find((l) => l.startsWith("- **Rate limits on member routes:**"));
    expect(line).toBeDefined();
    expect(line).toContain("architecture rate-limit table");
    expect(line).not.toMatch(/\d+ per \d+ s/);
  });
});
