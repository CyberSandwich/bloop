// The member limits are stated once, in the architecture rate-limit table, and must equal wrangler.jsonc's bindings.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const BINDINGS = ["RL_MEMBER_IP", "RL_MEMBER"] as const;

/** A binding's `{ limit, period }` as wrangler.jsonc declares it. */
function declared(name: string) {
  const m = new RegExp(`"name": "${name}"[^}]*"limit": (\\d+), "period": (\\d+)`).exec(read("wrangler.jsonc"));
  if (!m) throw new Error(`wrangler.jsonc declares no ${name}`);
  return { limit: Number(m[1]), period: Number(m[2]) };
}

describe("AUTH-19 meter: the member limits in the docs are the declared ones", () => {
  it("AUTH-19 meter: the architecture member routes row states each limit as wrangler.jsonc declares it", () => {
    const row = read("docs/architecture.md")
      .split("\n")
      .find((line) => line.startsWith("| member routes (`/api/me/*`) |"));
    expect(row).toBeDefined();
    for (const name of BINDINGS) {
      const stated = new RegExp(`(\\d+) per (\\d+) s per \\w+ \\(\`${name}\`\\)`).exec(row ?? "");
      expect(stated, name).not.toBeNull();
      expect({ limit: Number(stated?.[1]), period: Number(stated?.[2]) }, name).toEqual(declared(name));
    }
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
