import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSafeCall,
  buildPlan,
  type Deps,
  describeRequests,
  execute,
  floorsOf,
  main,
  meterNames,
  type Plan,
  parseCli,
  renderPlan,
  type Table,
  tokenFor,
  wranglerSettings,
  writeSql,
} from "../../tools/lockdown.mjs";
import { ACCOUNT, deps, fakeApi, GH_TOKEN, LOCK_TOKEN, NOW, TOKEN, table } from "./lockdown-fakes";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LEVELS = ["L1", "L2", "L3", "L4", "L5"];

const planFor = (level: string, undo = false) =>
  buildPlan(table, { level, undo, meter: level === "L1" ? "convert" : undefined });
const text = (r: { lines: string[] }) => r.lines.join("\n");
/** The Cloudflare and GitHub requests, without the site probe that opens every run. */
const apiCalls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => !c.url.endsWith("/api/health"));

// ---------- the table ----------

describe("rung table shape", () => {
  it("has exactly L1 to L5, each with a title, mechanism, writes, calls, manual steps and an undo", () => {
    expect(Object.keys(table.rungs)).toEqual(LEVELS);
    for (const [level, rung] of Object.entries(table.rungs)) {
      expect(rung.title, level).toMatch(/\S/);
      expect(rung.mechanism, level).toMatch(/\S/);
      expect(Array.isArray(rung.writes), level).toBe(true);
      expect(Array.isArray(rung.calls), level).toBe(true);
      expect(Array.isArray(rung.manual), level).toBe(true);
      expect(rung.undo.summary, level).toMatch(/\S/);
    }
  });

  it("includes point at an earlier rung", () => {
    for (const [level, rung] of Object.entries(table.rungs)) {
      if (rung.includes) expect(LEVELS.indexOf(rung.includes), level).toBeLessThan(LEVELS.indexOf(level));
    }
  });

  const meterWrites = Object.entries(table.rungs.L1?.meters ?? {}).map(([switch_, value]) => ({
    switch: switch_,
    value,
  }));
  const allWrites = [...Object.values(table.rungs).flatMap((r) => r.writes), ...meterWrites];

  it("every switch has allowed values, a default among them, and every write uses an allowed value", () => {
    for (const [name, spec] of Object.entries(table.switches)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(spec.values, name).toContain(spec.default);
    }
    expect(allWrites.length).toBeGreaterThan(10);
    for (const w of allWrites) expect(table.switches[w.switch]?.values, w.switch).toContain(w.value);
  });

  it("every write is stricter than its switch default (a lockdown never loosens)", () => {
    for (const w of allWrites) {
      const spec = table.switches[w.switch];
      expect(spec?.values.indexOf(w.value), w.switch).toBeGreaterThan(spec?.values.indexOf(spec.default) ?? 99);
    }
  });

  it("every call names an op, a permission, whether the deploy token holds it, and an undo", () => {
    const ids = new Set<string>();
    for (const rung of Object.values(table.rungs)) {
      for (const call of rung.calls) {
        expect(ids.has(call.id), call.id).toBe(false);
        ids.add(call.id);
        expect(call.permission).toMatch(/\S/);
        expect(typeof call.held).toBe("boolean");
        expect(() => describeRequests(table, call), call.id).not.toThrow();
      }
    }
  });

  it("L4 is the WAF rule plus workers.dev off, and L5 adds no API call that revokes a token", () => {
    expect(table.rungs.L4?.calls.map((c) => c.op)).toEqual(["wafRule", "workersDev"]);
    expect(table.rungs.L5?.includes).toBe("L4");
    expect(table.rungs.L5?.calls.map((c) => c.op)).toEqual(["clearSchedules"]);
    expect(table.rungs.L5?.manual.join(" ")).toMatch(/revoke/i);
  });

  it("only L1 and L2 may fall back to the deploy token", () => {
    expect(table.deployTokenLevels).toEqual(["L1", "L2"]);
    expect(tokenFor(table, "L2", { CLOUDFLARE_API_TOKEN: TOKEN })).toBe(TOKEN);
    expect(tokenFor(table, "L3", { CLOUDFLARE_API_TOKEN: TOKEN })).toBeUndefined();
    expect(tokenFor(table, "L3", { CLOUDFLARE_API_TOKEN: TOKEN, LOCKDOWN_CF_TOKEN: LOCK_TOKEN })).toBe(LOCK_TOKEN);
    expect(tokenFor(table, "L1", { CLOUDFLARE_API_TOKEN: TOKEN, LOCKDOWN_CF_TOKEN: LOCK_TOKEN })).toBe(LOCK_TOKEN);
  });

  it("the floors are SWITCH_<NAME>=value for every write", () => {
    expect(floorsOf(planFor("L2"))).toContainEqual({ name: "SWITCH_CONVERT", value: "off" });
    expect(floorsOf(planFor("L2"))).toHaveLength(7);
    expect(floorsOf(planFor("L2", true))).toEqual([]);
  });

  // Skipped until the spend guard lands. G's wiring (tasks/g-wiring.md) adds the check that L2's writes equal its
  // costly-flips list, beside this one for names, values and defaults.
  const registry = `${ROOT}src/worker/spend/switches.ts`;
  it.skipIf(!existsSync(registry))(
    "the switch names, values and defaults match src/worker/spend/switches.ts",
    async () => {
      const mod = (await import(/* @vite-ignore */ registry)) as {
        SWITCHES: Record<string, { values: readonly string[]; default: string }>;
      };
      for (const [name, spec] of Object.entries(table.switches)) {
        expect(mod.SWITCHES[name], name).toBeDefined();
        expect(spec.values, name).toEqual([...(mod.SWITCHES[name]?.values ?? [])]);
        expect(spec.default, name).toBe(mod.SWITCHES[name]?.default);
      }
    },
  );
});

describe("every rung has an undo", () => {
  for (const level of LEVELS) {
    it(`${level}: the undo plan restores each write and undoes each call or says how by hand`, () => {
      const set = planFor(level);
      const undo = planFor(level, true);
      expect(undo.undo).toBe(true);
      expect(undo.freeze.action).toBe("enable");
      expect(set.freeze.action).toBe("disable");
      expect(undo.writes.map((w) => w.switch)).toEqual(set.writes.map((w) => w.switch));
      for (const w of undo.writes) expect(w.value).toBe(table.switches[w.switch]?.default);
      const rungs = [level, table.rungs[level]?.includes].flatMap((l) => (l ? [l] : []));
      const calls = rungs.flatMap((l) => table.rungs[l]?.calls ?? []);
      expect(undo.calls).toHaveLength(calls.filter((c) => "op" in c.undo).length);
      // One line per call with no op undo, and one telling the owner to remove hand-set variable floors.
      const floorLine = undo.writes.length ? 1 : 0;
      expect(undo.manual).toHaveLength(calls.filter((c) => "manual" in c.undo).length + floorLine);
    });
  }

  it("an undo tells the owner to remove any SWITCH_ floor set by hand", () => {
    const manual = planFor("L2", true).manual.join("\n");
    expect(manual).toContain("SWITCH_CONVERT");
    expect(manual).toMatch(/never loosens a floor/);
    expect(planFor("L2").manual.join("\n")).not.toContain("SWITCH_CONVERT");
  });

  it("every call's undo is an op the table can describe, or a manual sentence", () => {
    for (const rung of Object.values(table.rungs)) {
      for (const call of rung.calls) {
        if ("op" in call.undo) expect(() => describeRequests(table, call.undo as never)).not.toThrow();
        else expect(call.undo.manual).toMatch(/\S/);
      }
    }
  });

  it("the L5 undo restores the cron triggers; it is no longer a manual step", () => {
    const undo = planFor("L5", true);
    expect(undo.calls.map((c) => c.op)).toContain("restoreSchedules");
    expect(undo.manual.join(" ")).not.toMatch(/cron/i);
  });
});

// ---------- safety ----------

describe("safety: nothing is deleted, no script is deployed", () => {
  const accounts = "/accounts/ACC";
  it("refuses DELETE anywhere and any write to a script, bucket, database or Durable Object", () => {
    for (const path of [
      `${accounts}/workers/scripts/bloop`,
      `${accounts}/r2/buckets/bloop-library`,
      `${accounts}/d1/database/uuid`,
      `${accounts}/workers/durable_objects/namespaces/x`,
      `${accounts}/workers/scripts/bloop/content`,
      "/repos/o/r/actions/workflows/deploy.yml",
    ]) {
      expect(() => assertSafeCall("DELETE", path), path).toThrow(/refused/);
    }
    for (const method of ["PUT", "POST", "PATCH"]) {
      for (const path of [
        `${accounts}/workers/scripts/bloop`,
        `${accounts}/workers/scripts/bloop/content`,
        `${accounts}/workers/scripts/bloop/versions`,
        `${accounts}/workers/scripts/bloop/deployments`,
        `${accounts}/workers/scripts/bloop/settings`,
        `${accounts}/workers/scripts/bloop/secrets`,
        `${accounts}/workers/services/bloop`,
        `${accounts}/r2/buckets/bloop-guest-files/lifecycle`,
        `${accounts}/d1/database/uuid/query`,
        `${accounts}/workers/durable_objects/namespaces/x`,
        "/repos/o/r/actions/runs/1/rerun",
        "/repos/o/r/actions/secrets/X",
        "/repos/o/r/git/refs",
      ]) {
        expect(() => assertSafeCall(method, path), `${method} ${path}`).toThrow(/refused/);
      }
    }
  });

  it("allows reads and the subresources the ladder uses, and only the run cancel on GitHub", () => {
    expect(() => assertSafeCall("GET", `${accounts}/workers/scripts/bloop`)).not.toThrow();
    for (const [method, path] of [
      ["POST", `${accounts}/workers/scripts/bloop/subdomain`],
      ["PUT", `${accounts}/workers/scripts/bloop/schedules`],
      ["POST", "/zones/z/rulesets/r/rules"],
      ["PATCH", "/zones/z/rulesets/r/rules/x"],
      ["PUT", "/zones/z/rulesets/phases/http_request_firewall_custom/entrypoint"],
      ["PATCH", `${accounts}/workflows/bloop-convert/instances/i/status`],
      ["POST", `${accounts}/workflows/bloop-convert/instances/batch/terminate`],
      ["PUT", "/repos/o/r/actions/workflows/deploy.yml/disable"],
      ["POST", "/repos/o/r/actions/runs/123/cancel"],
    ] as const) {
      expect(() => assertSafeCall(method, path), `${method} ${path}`).not.toThrow();
    }
  });

  it("no rung, set or undo, plans a forbidden request or any DELETE", () => {
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        for (const call of planFor(level, undo).calls) {
          for (const r of describeRequests(table, call)) {
            expect(r.method, `${level} ${call.id}`).not.toBe("DELETE");
            expect(() => assertSafeCall(r.method, r.path), `${level} ${r.method} ${r.path}`).not.toThrow();
          }
        }
      }
    }
  });

  it("applying every rung, set and undo, sends only safe requests and only wrangler d1 execute", async () => {
    const { deps: d, api, d1 } = deps();
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        const result = await execute(table, planFor(level, undo), d);
        expect(result.failed, text(result)).toBe(false);
      }
    }
    expect(api.calls.length).toBeGreaterThan(20);
    for (const c of api.calls) {
      expect(c.method).not.toBe("DELETE");
      const path = new URL(c.url).pathname;
      expect(() => assertSafeCall(c.method, path), `${c.method} ${path}`).not.toThrow();
      expect(path).not.toMatch(/\/workers\/scripts\/bloop$/);
    }
    for (const argv of d1.argvs)
      expect(argv.slice(0, 4)).toEqual([
        "node",
        expect.stringMatching(/tools\/pinned-wrangler\.mjs$/),
        "d1",
        "execute",
      ]);
  });

  it("an op the code does not implement fails its step: a table row can name no request of its own", async () => {
    const evil: Table = structuredClone(table);
    const l4 = evil.rungs.L4 as Table["rungs"][string];
    l4.calls = [{ id: "x", op: "nope", params: {}, permission: "p", held: true, undo: { manual: "m" } }];
    await expect(execute(evil, buildPlan(evil, { level: "L4", undo: false }), deps().deps)).resolves.toMatchObject({
      failed: true,
    });
  });
});

// ---------- the tokens ----------

describe("the lockdown token", () => {
  it("L3 to L5 refuse to run on the deploy token and make no request", async () => {
    for (const level of ["L3", "L4", "L5"]) {
      const { deps: d, api, d1 } = deps(undefined, undefined, { LOCKDOWN_CF_TOKEN: undefined });
      const { code, out } = await main(["--level", level, "--apply"], d);
      expect(code, level).toBe(2);
      expect(out).toContain("LOCKDOWN_CF_TOKEN");
      expect(apiCalls(api)).toHaveLength(0);
      expect(d1.argvs).toHaveLength(0);
    }
  });

  it("L1 and L2 fall back to the deploy token", async () => {
    const { deps: d, d1 } = deps(undefined, undefined, { LOCKDOWN_CF_TOKEN: undefined });
    const result = await execute(table, planFor("L2"), d);
    expect(result.failed).toBe(false);
    expect(d1.envs[0]?.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
  });

  it("the lockdown token is the one used for Cloudflare calls and handed to wrangler", async () => {
    const { deps: d, api, d1 } = deps();
    await execute(table, planFor("L3"), d);
    const cloudflare = api.calls.filter((c) => new URL(c.url).host === "api.cloudflare.com");
    expect(cloudflare.length).toBeGreaterThan(0);
    for (const c of cloudflare) expect(c.auth).toBe(`Bearer ${LOCK_TOKEN}`);
    expect(d1.envs[0]).toEqual({ CLOUDFLARE_API_TOKEN: LOCK_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  });

  it("the dry run proves wrangler runs with a read-only SELECT 1, and says so when it cannot", async () => {
    const good = deps();
    const out = (await main(["--level", "L2"], good.deps)).out;
    expect(out).toContain("wrangler: d1 execute reached the database (read-only SELECT 1)");
    expect(good.d1.argvs).toHaveLength(1);
    expect(good.d1.argvs[0]?.slice(0, 4)).toEqual([
      "node",
      expect.stringMatching(/tools\/pinned-wrangler\.mjs$/),
      "d1",
      "execute",
    ]);
    expect(good.d1.argvs[0]).toContain("--remote");
    const bad = deps();
    bad.d1.failNext();
    expect((await main(["--level", "L2"], bad.deps)).out).toMatch(
      /L2 WILL FAIL: wrangler d1 execute failed \(D1 is down\)/,
    );
    const none = deps();
    await main(["--level", "L4"], none.deps);
    expect(none.d1.argvs).toHaveLength(0);
  });

  it("the dry run verifies the token and says which rung will fail for what", async () => {
    const ok = deps();
    const good = (await main(["--level", "L4"], ok.deps)).out;
    expect(good).toContain("token: active");
    expect(good).toMatch(/L4: the reads this rung starts with are allowed/);
    expect(ok.api.mutating()).toHaveLength(0);

    const noZone = deps();
    noZone.api.state.denied = ["/zones"];
    expect((await main(["--level", "L4"], noZone.deps)).out).toMatch(/L4 WILL FAIL: token lacks Zone Read/);

    const noWaf = deps();
    noWaf.api.state.denied = ["/rulesets/"];
    expect((await main(["--level", "L4"], noWaf.deps)).out).toMatch(/L4 WILL FAIL: token lacks Zone WAF Edit/);

    const noScripts = deps();
    noScripts.api.state.denied = ["/workers/scripts"];
    expect((await main(["--level", "L5"], noScripts.deps)).out).toMatch(/WILL FAIL: token lacks Workers Scripts Write/);

    const noD1 = deps();
    noD1.api.state.denied = ["/d1/"];
    expect((await main(["--level", "L2"], noD1.deps)).out).toMatch(/L2 WILL FAIL: token lacks D1 Edit/);

    const dead = deps();
    dead.api.state.verify = "expired";
    expect((await main(["--level", "L2"], dead.deps)).out).toMatch(/L2 WILL FAIL: the token did not verify/);

    const missing = deps(undefined, undefined, { LOCKDOWN_CF_TOKEN: undefined });
    expect((await main(["--level", "L3"], missing.deps)).out).toMatch(/L3 WILL FAIL: LOCKDOWN_CF_TOKEN is not set/);
    expect(apiCalls(missing.api)).toHaveLength(0);
  });

  it("no credentials in the environment: the dry run says so and makes no call", async () => {
    const { deps: d, api } = deps(undefined, undefined, {
      LOCKDOWN_CF_TOKEN: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
    });
    const { out } = await main(["--level", "L2"], d);
    expect(out).toContain("token: not checked");
    expect(apiCalls(api)).toHaveLength(0);
  });
});

// ---------- dry run ----------

describe("dry run", () => {
  it("never writes: no wrangler, no mutating request, for every rung, set and undo", async () => {
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        const { deps: d, api, d1 } = deps();
        const argv = ["--level", level, ...(level === "L1" ? ["--meter", "uploads"] : []), ...(undo ? ["--undo"] : [])];
        const { code, out } = await main(argv, d);
        expect(code, out).toBe(0);
        expect(api.mutating(), `${level} ${undo}`).toHaveLength(0);
        // The one wrangler call a dry run makes is the read-only SELECT 1 that proves the toolchain.
        for (const a of d1.argvs) expect(a.at(-1), `${level} ${undo}`).toBe("SELECT 1;");
        expect(d1.argvs.length).toBe(planFor(level).writes.length ? 1 : 0);
        expect(d1.rows()).toEqual({});
        expect(out).toContain("dry run");
      }
    }
  });

  it("prints the exact SQL, the floors and the requests, and never a credential", async () => {
    const { deps: d } = deps();
    const { out } = await main(["--level", "L2"], d);
    expect(out).toContain("INSERT INTO setting");
    expect(out).toContain("INSERT INTO admin_action");
    expect(out).toContain("SWITCH_UPLOADS=readonly");
    const l5 = (await main(["--level", "L5"], d)).out;
    expect(l5).toContain("POST /zones/{zone}/rulesets/{ruleset}/rules");
    expect(l5).toContain("PUT /accounts/{account}/workers/scripts/bloop/schedules");
    expect(l5).toContain("runs/{id}/cancel");
    for (const secret of [TOKEN, LOCK_TOKEN, ACCOUNT, GH_TOKEN]) {
      expect(out).not.toContain(secret);
      expect(l5).not.toContain(secret);
    }
  });

  it("is the default: --apply is the only thing that changes anything", async () => {
    const { deps: d, d1 } = deps();
    await main(["--level", "L2"], d);
    expect(d1.settings()).toEqual([]);
    expect(parseCli(["--level", "L2"]).apply).toBe(false);
    expect(parseCli(["--level", "L2", "--apply"]).apply).toBe(true);
  });
});

// ---------- apply ----------

describe("apply", () => {
  it("L2 writes seven rows labeled lockdown:L2 and seven log lines with the actor lockdown", async () => {
    const { deps: d, d1 } = deps();
    const result = await execute(table, planFor("L2"), d);
    expect(result.failed).toBe(false);
    const rows = d1.rows();
    expect(Object.values(Object.entries(rows).map(([k, r]) => `${k}=${r.value}`)).sort()).toEqual([
      "convert=off",
      "demo_drop=off",
      "email=admin_only",
      "export=off",
      "guest_drop=off",
      "previews=off",
      "uploads=readonly",
    ]);
    for (const r of Object.values(rows)) expect(r.updated_by).toBe("lockdown:L2");
    const log = d1.log();
    expect(log).toHaveLength(7);
    for (const l of log) expect(l).toMatchObject({ admin_user_id: "lockdown", target_kind: "setting", at: NOW });
    expect(log.find((l) => l.target_id === "convert")?.reason).toBe("lockdown L2 set convert=off prior=account_only");
  });

  it("every write goes in one wrangler call, parameter-free SQL through `d1 execute <db> --remote --command`", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L3"), d);
    expect(d1.argvs).toHaveLength(1);
    const argv = d1.argvs[0] ?? [];
    expect(argv.slice(0, 7)).toEqual([
      "node",
      expect.stringMatching(/tools\/pinned-wrangler\.mjs$/),
      "d1",
      "execute",
      "bloop",
      "--remote",
      "--json",
    ]);
    expect(argv[7]).toBe("--command");
    expect((argv[8] ?? "").split("\n")).toHaveLength(24);
  });

  it("L3 raises email to off and adds convert_video", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L3"), d);
    expect(d1.rows()).toMatchObject({
      email: { value: "off" },
      convert_video: { value: "off" },
      convert: { value: "off" },
    });
  });

  it("L4 adds the block rule once and turns workers.dev and previews off; L5 clears the crons", async () => {
    const { deps: d, api } = deps();
    api.state.workersDev = { enabled: true, previews_enabled: true };
    await execute(table, planFor("L5"), d);
    expect(api.state.ruleset?.rules).toHaveLength(1);
    expect(api.state.ruleset?.rules[0]).toMatchObject({ ref: "lockdown", action: "block", enabled: true });
    expect(api.state.workersDev).toEqual({ enabled: false, previews_enabled: false });
    expect(api.state.crons).toEqual([]);
    expect(api.state.deployState).toBe("disabled_manually");
  });

  it("workers.dev already off with previews still on is changed, not skipped", async () => {
    const { deps: d, api } = deps();
    api.state.workersDev = { enabled: false, previews_enabled: true };
    const result = await execute(table, planFor("L4"), d);
    expect(api.state.workersDev).toEqual({ enabled: false, previews_enabled: false });
    expect(text(result)).toContain("changed: workers.dev off, previews off");
  });

  it("an L4 undo disables the rule but keeps it, and puts workers.dev and previews back as wrangler.jsonc has them", async () => {
    for (const previews of [false, true]) {
      const { deps: d, api } = deps(undefined, undefined, {}, { crons: ["0 * * * *"], previews });
      await execute(table, planFor("L4"), d);
      await execute(table, planFor("L4", true), d);
      expect(api.state.ruleset?.rules).toHaveLength(1);
      expect(api.state.ruleset?.rules[0]).toMatchObject({ enabled: false });
      expect(api.state.workersDev).toEqual({ enabled: true, previews_enabled: previews });
      expect(api.state.deployState).toBe("active");
    }
  });

  it("the L5 undo puts back exactly the crons wrangler.jsonc lists, and a second undo changes nothing", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L5"), d);
    expect(api.state.crons).toEqual([]);
    await execute(table, planFor("L5", true), d);
    expect(api.state.crons.map((c) => c.cron)).toEqual(wranglerSettings().crons);
    expect(wranglerSettings().crons.length).toBeGreaterThan(0);
    const before = api.mutating().length;
    await execute(table, planFor("L5", true), d);
    expect(api.mutating()).toHaveLength(before);
  });

  it("wrangler settings come from the real wrangler.jsonc: its cron triggers and preview_urls", () => {
    const s = wranglerSettings();
    expect(s.crons).toContain("0 * * * *");
    expect(s.previews).toBe(false);
  });
});

// ---------- freezing deploys ----------

describe("freezing deploys", () => {
  it("a set cancels the deploy runs in progress and queued, and a second run cancels none", async () => {
    const { deps: d, api } = deps();
    api.state.runs = [
      { id: 11, status: "in_progress" },
      { id: 12, status: "queued" },
      { id: 13, status: "completed" },
    ];
    const result = await execute(table, planFor("L2"), d);
    expect(text(result)).toContain("2 run(s) cancelled");
    expect(api.calls.filter((c) => c.url.endsWith("/cancel")).map((c) => c.url.match(/runs\/(\d+)/)?.[1])).toEqual([
      "11",
      "12",
    ]);
    expect(api.state.runs.map((r) => r.id)).toEqual([13]);
    const before = api.calls.filter((c) => c.url.endsWith("/cancel")).length;
    await execute(table, planFor("L2"), d);
    expect(api.calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(before);
  });

  it("an undo cancels nothing", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L2"), d);
    api.state.runs = [{ id: 21, status: "in_progress" }];
    await execute(table, planFor("L2", true), d);
    expect(api.state.runs).toHaveLength(1);
  });

  it("warns, with a headline and exit 3, when deploys could not be frozen", async () => {
    const { deps: d } = deps(undefined, undefined, { GITHUB_TOKEN: undefined });
    const result = await execute(table, planFor("L2"), d);
    expect(result.warned).toBe(true);
    expect(result.failed).toBe(false);
    // Line 0 is the spend-block answer; the headline follows it.
    expect(result.lines[1]).toMatch(/^DEPLOYS NOT FROZEN/);
    const run = await main(["--level", "L2", "--apply"], d);
    expect(run.code).toBe(3);
    expect(run.out.split("\n")[1]).toMatch(/^DEPLOYS NOT FROZEN/);
  });

  it("a failed freeze warns too, and a failure outranks the warning in the exit code", async () => {
    const { deps: d, api } = deps();
    api.state.githubFails = true;
    const result = await execute(table, planFor("L2"), d);
    expect(result.warned).toBe(true);
    expect(result.failed).toBe(true);
    expect((await main(["--level", "L2", "--apply"], d)).code).toBe(1);
  });

  it("a frozen set is not a warning, and an undo that cannot enable deploys says they stay frozen", async () => {
    const ok = await execute(table, planFor("L2"), deps().deps);
    expect(ok.warned).toBe(false);
    expect(ok.stillFrozen).toBe(false);
    const { deps: d } = deps(undefined, undefined, { GITHUB_TOKEN: undefined });
    const undo = await execute(table, planFor("L2", true), d);
    expect(undo.warned).toBe(false);
    expect(undo.stillFrozen).toBe(true);
    expect(undo.lines[1]).toMatch(/^DEPLOYS STILL FROZEN/);
    expect((await main(["--level", "L2", "--undo", "--apply"], d)).code).toBe(3);
  });

  it("an undo that cannot read the L4 state exits 3 with DEPLOYS STILL FROZEN", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L2"), d);
    api.state.denied = ["/zones"];
    const run = await main(["--level", "L2", "--undo", "--apply"], d);
    expect(run.code).toBe(3);
    expect(run.out.split("\n")[1]).toMatch(/^DEPLOYS STILL FROZEN/);
    expect(api.state.deployState).toBe("disabled_manually");
  });

  it("an undo skipped because L4 is in force is intended, not a warning", async () => {
    const { deps: d } = deps();
    await execute(table, planFor("L4"), d);
    const run = await main(["--level", "L2", "--undo", "--apply"], d);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("DEPLOYS STILL FROZEN");
  });

  it("an L1 to L3 undo does not unfreeze while L4 is in force, and says why", async () => {
    for (const how of ["rule", "workers.dev"] as const) {
      const { deps: d, api } = deps();
      await execute(table, planFor("L3"), d);
      await execute(table, planFor("L4"), d);
      if (how === "rule") api.state.workersDev = { enabled: true, previews_enabled: false };
      else if (api.state.ruleset)
        api.state.ruleset.rules = api.state.ruleset.rules.map((r) => ({ ...r, enabled: false }));
      const result = await execute(table, planFor("L3", true), d);
      expect(api.state.deployState, how).toBe("disabled_manually");
      expect(text(result)).toMatch(
        /enable deploys \(deploy\.yml\): skipped, .*(WAF block rule is on|workers\.dev is off)/,
      );
      expect(result.failed).toBe(false);
    }
  });

  it("an L1 to L3 undo unfreezes when L4 is not in force", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L3"), d);
    expect(api.state.deployState).toBe("disabled_manually");
    await execute(table, planFor("L3", true), d);
    expect(api.state.deployState).toBe("active");
  });

  it("an undo that cannot read the L4 state keeps deploys frozen", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L2"), d);
    api.state.denied = ["/zones"];
    const result = await execute(table, planFor("L2", true), d);
    expect(api.state.deployState).toBe("disabled_manually");
    expect(text(result)).toMatch(/skipped, could not read the L4 state/);
  });

  it("an L4 undo unfreezes after it has turned the edge back on", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L4"), d);
    await execute(table, planFor("L4", true), d);
    expect(api.state.deployState).toBe("active");
  });
});

// ---------- Workflow instances ----------

describe("terminating Workflow instances", () => {
  it("L3 terminates live instances in one batch call, then lists again", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L3"), d);
    expect(api.state.instances).toEqual([]);
    const batches = api.calls.filter((c) => c.url.endsWith("/instances/batch/terminate"));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.body).toEqual(["inst-a", "inst-b"]);
    expect(api.calls.filter((c) => /\/status$/.test(c.url))).toHaveLength(0);
    const lastBatch = api.calls.indexOf(batches[0] as never);
    expect(api.calls.slice(lastBatch + 1).filter((c) => c.url.includes("/instances?status="))).not.toHaveLength(0);
  });

  it("pages on the cursor, in batches of at most 100 ids", async () => {
    const { deps: d, api } = deps();
    api.state.pageSize = 100;
    api.state.instances = Array.from({ length: 250 }, (_, i) => ({ id: `i${i}`, status: "running" }));
    await execute(table, planFor("L3"), d);
    const sizes = api.calls.filter((c) => c.url.endsWith("/batch/terminate")).map((c) => (c.body as string[]).length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(api.state.instances).toEqual([]);
    expect(api.calls.filter((c) => c.url.includes("cursor=")).length).toBeGreaterThanOrEqual(2);
  });

  it("includes paused and waitingForPause, and every other live state", async () => {
    const { deps: d, api } = deps();
    api.state.instances = ["queued", "running", "paused", "waitingForPause", "waiting", "complete"].map((status) => ({
      id: `i-${status}`,
      status,
    }));
    await execute(table, planFor("L3"), d);
    expect(api.state.instances.map((i) => i.status)).toEqual(["complete"]);
  });

  it("fails the step when an instance is still live after terminate, and waits between looks", async () => {
    const { deps: d, api, slept } = deps();
    api.state.sticky = new Set(["inst-a"]);
    const result = await execute(table, planFor("L3"), d);
    expect(result.failed).toBe(true);
    expect(text(result)).toMatch(/terminate-workflows: FAILED 1 instance\(s\) still live/);
    expect(slept.length).toBeGreaterThan(0);
  });

  it("looks again up to five times with doubling waits, and no wait after the last look", async () => {
    const lagging = deps();
    lagging.api.state.lag = 3;
    const ok = await execute(table, planFor("L3"), lagging.deps);
    expect(ok.failed).toBe(false);
    expect(lagging.slept).toEqual([1000, 2000]);

    const never = deps();
    never.api.state.lag = 99;
    const bad = await execute(table, planFor("L3"), never.deps);
    expect(bad.failed).toBe(true);
    expect(never.slept).toEqual([1000, 2000, 4000, 8000]);
  });

  it("falls back to one PATCH per instance only when the batch call answers 404 or 405", async () => {
    for (const status of [404, 405]) {
      const { deps: d, api } = deps();
      api.state.batchStatus = status;
      const result = await execute(table, planFor("L3"), d);
      expect(result.failed, String(status)).toBe(false);
      expect(api.state.instances).toEqual([]);
      expect(api.calls.filter((c) => /\/status$/.test(c.url))).toHaveLength(2);
    }
  });

  it("a batch failure that is not 404 or 405 fails the step and never falls back", async () => {
    for (const status of [403, 500]) {
      const { deps: d, api } = deps();
      api.state.batchStatus = status;
      const result = await execute(table, planFor("L3"), d);
      expect(result.failed, String(status)).toBe(true);
      expect(api.calls.filter((c) => /\/status$/.test(c.url))).toHaveLength(0);
    }
  });

  it("backs off on 429 using Retry-After, then succeeds", async () => {
    const { deps: d, api, slept } = deps();
    api.state.rateLimited = 2;
    const result = await execute(table, planFor("L3"), d);
    expect(result.failed).toBe(false);
    expect(slept.slice(0, 2)).toEqual([1000, 1000]);
    expect(api.calls.filter((c) => c.url.endsWith("/batch/terminate"))).toHaveLength(3);
  });

  it("gives up on a 429 that never clears", async () => {
    const { deps: d, api } = deps();
    api.state.rateLimited = 99;
    const result = await execute(table, planFor("L3"), d);
    expect(result.failed).toBe(true);
    expect(text(result)).toContain("answered 429");
  });

  it("carries on past a single PATCH failure and counts it", async () => {
    const { deps: d, api } = deps();
    api.state.batchStatus = 404;
    api.state.patchFails = new Set(["inst-a"]);
    const result = await execute(table, planFor("L3"), d);
    expect(result.failed).toBe(true);
    expect(text(result)).toMatch(/1 single terminate\(s\) failed/);
    expect(api.state.instances.map((i) => i.id)).toEqual(["inst-a"]);
  });
});

// ---------- idempotence and the undo's reach ----------

describe("idempotence", () => {
  for (const level of LEVELS) {
    for (const undo of [false, true]) {
      it(`${level}${undo ? " undo" : ""}: a second run changes nothing and makes no mutating request`, async () => {
        const { deps: d, d1, api } = deps();
        if (undo) await execute(table, planFor(level), d);
        await execute(table, planFor(level, undo), d);
        const settings = JSON.stringify(d1.settings());
        const log = JSON.stringify(d1.log());
        const state = JSON.stringify(api.state);
        const mutations = api.mutating().length;
        const second = await execute(table, planFor(level, undo), { ...d, now: () => NOW + 60_000 });
        expect(second.failed).toBe(false);
        expect(JSON.stringify(d1.settings())).toBe(settings);
        expect(JSON.stringify(d1.log())).toBe(log);
        expect(JSON.stringify(api.state)).toBe(state);
        expect(api.mutating()).toHaveLength(mutations);
      });
    }
  }

  it("reports changed the first time and unchanged the second", async () => {
    const { deps: d } = deps();
    const first = await execute(table, planFor("L1"), d);
    const second = await execute(table, planFor("L1"), { ...d, now: () => NOW + 1 });
    expect(text(first)).toMatch(/D1 convert -> off: changed/);
    expect(text(second)).toMatch(/D1 convert -> off: unchanged/);
  });

  it("never loosens: a stricter row stands, and nothing is logged for it", async () => {
    const { deps: d, d1 } = deps();
    d1.db.exec("INSERT INTO setting VALUES ('uploads', 'off', 5, 'owner'), ('convert', 'garbage', 5, 'owner')");
    await execute(table, planFor("L2"), d);
    expect(d1.rows().uploads).toMatchObject({ value: "off", updated_by: "owner" });
    expect(d1.rows().convert).toMatchObject({ value: "garbage", updated_by: "owner" });
    const logged = d1.log().map((l) => l.target_id);
    expect(logged).not.toContain("uploads");
    expect(logged).not.toContain("convert");
  });

  it("an undo touches only rows lockdown wrote", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    d1.db.exec("UPDATE setting SET value = 'off', updated_by = 'breaker' WHERE key = 'email'");
    await execute(table, planFor("L2", true), d);
    expect(d1.rows().email?.value).toBe("off");
    expect(d1.rows().uploads?.value).toBe("on");
  });
});

describe("undo scope and the recorded prior value", () => {
  it("restores the value the row held before, not the default", async () => {
    const { deps: d, d1 } = deps();
    d1.db.exec("INSERT INTO setting VALUES ('convert', 'on', 5, 'owner')");
    await execute(table, planFor("L2"), d);
    expect(d1.rows().convert?.value).toBe("off");
    expect(d1.log().find((l) => l.target_id === "convert")?.reason).toBe("lockdown L2 set convert=off prior=on");
    await execute(table, planFor("L2", true), d);
    expect(d1.rows().convert).toMatchObject({ value: "on", updated_by: "lockdown:undo" });
    expect(d1.rows().uploads?.value).toBe("on");
    expect(d1.log().filter((l) => l.action === "lockdown.undo")).toHaveLength(7);
  });

  it("L3, then undo L2: the rows L3 wrote are not undone, and deploys stay in step", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L3"), d);
    const before = JSON.stringify(d1.settings());
    await execute(table, planFor("L2", true), d);
    expect(JSON.stringify(d1.settings())).toBe(before);
    expect(d1.rows().email).toMatchObject({ value: "off", updated_by: "lockdown:L3" });
  });

  it("L2 then L3, then undo L3: every row goes back to what it was before any lockdown", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    await execute(table, planFor("L3"), d);
    expect(d1.rows().email).toMatchObject({ value: "off", updated_by: "lockdown:L3" });
    // An equal value is relabeled to the higher level, so it is no longer an L2 row.
    expect(d1.rows().convert).toMatchObject({ value: "off", updated_by: "lockdown:L3" });
    // The prior stays the value from before the first lockdown, not the L2 value L3 replaced.
    expect(d1.log().find((l) => l.reason.startsWith("lockdown L3 set email=off"))?.reason).toMatch(/prior=on$/);
    await execute(table, planFor("L3", true), d);
    for (const key of ["email", "convert_video", "uploads", "export", "previews"]) {
      expect(d1.rows()[key]?.value, key).toBe("on");
    }
    expect(d1.rows().convert?.value).toBe("account_only");
  });

  it("L2 then L3, then undo L2: every row L3 now holds stays, none is half undone", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    await execute(table, planFor("L3"), d);
    const before = JSON.stringify(d1.settings());
    const logged = d1.log().length;
    await execute(table, planFor("L2", true), d);
    expect(JSON.stringify(d1.settings())).toBe(before);
    expect(d1.log()).toHaveLength(logged);
    expect(d1.rows().uploads).toMatchObject({ value: "readonly", updated_by: "lockdown:L3" });
  });

  it("escalating over an equal value relabels it without a new log line or a new prior, and only once", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    const logged = d1.log().length;
    const result = await execute(table, planFor("L3"), { ...d, now: () => NOW + 1 });
    expect(d1.rows().uploads).toMatchObject({ value: "readonly", updated_by: "lockdown:L3" });
    expect(text(result)).toContain("D1 uploads -> readonly: relabeled");
    // Only email (admin_only to off) and convert_video are new sets; the rest only change label.
    expect(d1.log()).toHaveLength(logged + 2);
    const again = await execute(table, planFor("L3"), { ...d, now: () => NOW + 2 });
    expect(text(again)).toContain("D1 uploads -> readonly: unchanged");
    await execute(table, planFor("L3", true), d);
    expect(d1.rows().uploads?.value).toBe("on");
  });

  it("an L2 set never relabels an L3 row down", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L3"), d);
    await execute(table, planFor("L2"), { ...d, now: () => NOW + 1 });
    expect(d1.rows().uploads?.updated_by).toBe("lockdown:L3");
  });

  it("the owner set it looser, then a set, then an undo: the undo restores the owner's value", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    d1.db.exec("UPDATE setting SET value = 'on', updated_at = 9, updated_by = 'owner' WHERE key = 'convert'");
    await execute(table, planFor("L2"), { ...d, now: () => NOW + 1 });
    expect(d1.rows().convert).toMatchObject({ value: "off", updated_by: "lockdown:L2" });
    expect(
      d1
        .log()
        .filter((l) => l.target_id === "convert" && l.action === "lockdown.set")
        .map((l) => l.reason),
    ).toEqual(["lockdown L2 set convert=off prior=account_only", "lockdown L2 set convert=off prior=on"]);
    await execute(table, planFor("L2", true), { ...d, now: () => NOW + 2 });
    expect(d1.rows().convert?.value).toBe("on");
  });

  it("an undo reports each row by its own statements: a row it did not touch is unchanged", async () => {
    const { deps: d, d1 } = deps();
    d1.db.exec("INSERT INTO setting VALUES ('convert', 'off', 5, 'owner'), ('uploads', 'readonly', 5, 'lockdown:L2')");
    const result = await execute(table, planFor("L2", true), d);
    expect(text(result)).toContain("D1 convert restored to its prior value: unchanged");
    expect(text(result)).toContain("D1 uploads restored to its prior value: changed");
    expect(d1.rows().convert).toMatchObject({ value: "off", updated_by: "owner" });
  });

  it("a row with no prior logged restores its default", async () => {
    const { deps: d, d1 } = deps();
    d1.db.exec("INSERT INTO setting VALUES ('uploads', 'readonly', 5, 'lockdown:L2')");
    await execute(table, planFor("L2", true), d);
    expect(d1.rows().uploads?.value).toBe("on");
  });
});

// ---------- SQL ----------

describe("SQL is built only from the table", () => {
  const ALLOWED = new Set<string>([
    "lockdown",
    "lockdown.set",
    "lockdown.undo",
    "lockdown:undo",
    "lockdown:L[1-5]",
    "setting",
    "prior=",
    ...Object.keys(table.switches),
    ...Object.values(table.switches).flatMap((s) => s.values),
    ...LEVELS.map((l) => `lockdown:${l}`),
  ]);

  it("every quoted literal in every statement is a switch, a value, the actor or a fixed word, or the reason", () => {
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        for (const w of planFor(level, undo).writes) {
          for (const s of writeSql(table, w, { level, undo, now: NOW })) {
            for (const [, lit] of s.matchAll(/'([^']*)'/g)) {
              const literal = lit ?? "";
              const reason = /^lockdown L[1-5] (set [a-z_]+=[a-z_]+|undo [a-z_]+) prior=$/.test(literal);
              expect(ALLOWED.has(literal) || reason, `${literal} in ${s}`).toBe(true);
            }
            expect(s).not.toMatch(/--|\/\*|;\s*\S/);
          }
        }
      }
    }
  });

  it("refuses a switch or value outside the table, and anything that is not a plain token", () => {
    const ctx = { level: "L2", undo: false, now: NOW };
    expect(() => writeSql(table, { switch: "x; DROP TABLE setting", value: "off" }, ctx)).toThrow(/allowlisted/);
    expect(() => writeSql(table, { switch: "convert", value: "off' OR '1'='1" }, ctx)).toThrow(/not allowed/);
    expect(() => writeSql(table, { switch: "bogus", value: "off" }, ctx)).toThrow(/allowlisted/);
    expect(() => writeSql(table, { switch: "convert", value: "off" }, { ...ctx, now: Number.NaN })).toThrow();
    expect(() => writeSql(table, { switch: "convert", value: "off" }, { ...ctx, level: "L2'" })).toThrow();
    const tampered: Table = structuredClone(table);
    tampered.switches["a'b"] = { values: ["x'y"], default: "x'y" };
    expect(() => writeSql(tampered, { switch: "a'b", value: "x'y" }, ctx)).toThrow(/unexpected character/);
  });

  it("the meter is checked against the table before any SQL exists", () => {
    expect(() => buildPlan(table, { level: "L1", undo: false, meter: "convert'; DROP TABLE setting;--" })).toThrow(
      /--meter/,
    );
    expect(() => buildPlan(table, { level: "L1", undo: false })).toThrow(/--meter/);
    expect(() => buildPlan(table, { level: "L2", undo: false, meter: "convert" })).toThrow(/L1 only/);
    expect(() => buildPlan(table, { level: "L9", undo: false })).toThrow(/unknown level/);
    expect(meterNames(table)).toEqual(Object.keys(table.rungs.L1?.meters ?? {}));
  });
});

// ---------- credentials and failures ----------

describe("credentials and failures", () => {
  it("apply needs the account id and a token and says which is missing, never a value", async () => {
    const { deps: d } = deps(undefined, undefined, { LOCKDOWN_CF_TOKEN: undefined, CLOUDFLARE_API_TOKEN: undefined });
    const { code, out } = await main(["--level", "L2", "--apply"], d);
    expect(code).toBe(2);
    expect(out).toContain("LOCKDOWN_CF_TOKEN or CLOUDFLARE_API_TOKEN");
    expect(out).not.toContain(ACCOUNT);
  });

  it("no output of an apply holds a credential, even when an error echoes one", async () => {
    const { deps: d } = deps();
    const failing: Deps = {
      ...d,
      run: () => ({ status: 1, stderr: `bad token ${LOCK_TOKEN} ${TOKEN} for ${ACCOUNT}` }),
    };
    const { code, out } = await main(["--level", "L2", "--apply"], failing);
    expect(code).toBe(1);
    for (const secret of [LOCK_TOKEN, TOKEN, ACCOUNT, GH_TOKEN]) expect(out).not.toContain(secret);
  });

  it("a D1 failure is reported, the other steps still run, and the var floors are printed", async () => {
    const { deps: d, d1, api } = deps();
    d1.failNext();
    const result = await execute(table, planFor("L3"), d);
    expect(result.failed).toBe(true);
    expect(text(result)).toContain("SWITCH_CONVERT=off");
    expect(api.state.instances).toEqual([]);
  });

  it("a failing API call fails the run and names the status only", async () => {
    const api = fakeApi();
    const broken = { ...api, fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch };
    const { deps: d } = deps(undefined, broken);
    const result = await execute(table, planFor("L4"), d);
    expect(result.failed).toBe(true);
    expect(text(result)).toContain("answered 403");
  });

  it("the plan lists the permissions beyond the deploy token", () => {
    const l4: Plan = planFor("L4");
    expect(l4.permissions.filter((p) => !p.held).map((p) => p.name)).toEqual(["Zone Read and Zone WAF Edit"]);
    expect(planFor("L2").permissions.every((p) => p.held)).toBe(true);
    expect(renderPlan(table, l4, false)).toContain("(extra)");
    expect(renderPlan(table, l4, false)).toContain("Token: LOCKDOWN_CF_TOKEN\n");
  });
});
