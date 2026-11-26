// The two lockdown rules from the Cloudflare audit: the ladder opens by asking whether a spend block is active, and
// no rung redeploys with a forced Durable Object code update.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main, spendBlockCheck } from "../../tools/lockdown.mjs";
import { deps, table } from "./lockdown-fakes";

const LEVELS = ["L1", "L2", "L3", "L4", "L5"];
const argvFor = (level: string, ...rest: string[]) => [
  "--level",
  level,
  ...(level === "L1" ? ["--meter", "uploads"] : []),
  ...rest,
];
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

describe("the first check is whether a spend block is active", () => {
  it("probes the live site's /api/health before any other request, in a dry run and in an apply", async () => {
    for (const apply of [false, true]) {
      const { deps: d, api } = deps();
      await main(argvFor("L2", ...(apply ? ["--apply"] : [])), d);
      expect(api.calls[0]?.url, `apply ${apply}`).toBe(`https://${table.zone}/api/health`);
    }
  });

  it("an answering site is reported as no block; the line opens the output", async () => {
    const { deps: d } = deps();
    for (const apply of [false, true]) {
      const { out } = await main(argvFor("L2", ...(apply ? ["--apply"] : [])), d);
      expect(out.split("\n")[0], `apply ${apply}`).toContain("spend block: none seen");
    }
  });

  it("a site that answers 5xx or not at all is reported first, with the alert mails as the only signal", async () => {
    for (const site of [503, 0]) {
      for (const apply of [false, true]) {
        const { deps: d, api } = deps();
        api.state.site = site;
        const { out } = await main(argvFor("L2", ...(apply ? ["--apply"] : [])), d);
        expect(out.split("\n")[0], `${site} ${apply}`).toContain("SPEND BLOCK ACTIVE?");
        expect(out).toContain("the only signal");
        expect(out).toContain("$2, $5");
      }
    }
  });

  it("the answer stays the first line above a DEPLOYS headline, set or undo", async () => {
    for (const undo of [false, true]) {
      const { deps: d } = deps(undefined, undefined, { GITHUB_TOKEN: undefined, GITHUB_REPOSITORY: undefined });
      const { code, out } = await main(argvFor("L2", "--apply", ...(undo ? ["--undo"] : [])), d);
      const lines = out.split("\n");
      expect(code, `undo ${undo}`).toBe(3);
      expect(lines[0], `undo ${undo}`).toContain("spend block: none seen");
      expect(lines[1], `undo ${undo}`).toMatch(/^DEPLOYS (NOT|STILL) FROZEN/);
    }
  });

  it("an apply with credentials missing makes no request at all, the probe included", async () => {
    const { deps: d, api } = deps(undefined, undefined, {
      LOCKDOWN_CF_TOKEN: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
    });
    const { code } = await main(argvFor("L2", "--apply"), d);
    expect(code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("a block does not stop the ladder: the API calls are not Worker invocations, so the rungs still run", async () => {
    const { deps: d, api, d1 } = deps();
    api.state.site = 503;
    const { code } = await main(argvFor("L2", "--apply"), d);
    expect(code).toBe(0);
    expect(Object.keys(d1.rows())).toHaveLength(7);
  });

  it("the check reads only: one GET, no credential sent to the site", async () => {
    const { deps: d, api } = deps();
    expect(await spendBlockCheck(table, d)).toContain("none seen");
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: "GET", auth: "" });
  });
});

describe("no rung redeploys with a forced Durable Object code update", () => {
  it("every rung, set and undo, makes only `wrangler d1 execute` calls and sends no code-update mode", async () => {
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        const { deps: d, api, d1 } = deps();
        await main(argvFor(level, "--apply", ...(undo ? ["--undo"] : [])), d);
        for (const argv of d1.argvs)
          expect(argv.slice(0, 4), `${level} ${undo}`).toEqual(["npx", "wrangler", "d1", "execute"]);
        const sent = JSON.stringify([d1.argvs, api.calls]);
        expect(sent, `${level} ${undo}`).not.toMatch(/code.update.mode|immediate/i);
      }
    }
  });

  it("the rung table, the workflow and the doc do not name the mode as something to use", () => {
    expect(JSON.stringify(table)).not.toMatch(/code.update.mode|immediate/i);
    expect(read(".github/workflows/lockdown.yml")).not.toMatch(/code.update.mode|immediate/i);
    // The doc names the mode once, only to forbid it.
    const doc = read("docs/lockdown.md");
    const mentions = doc.split("\n").filter((l) => /code-update-mode|immediate/i.test(l));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/never/i);
  });
});
