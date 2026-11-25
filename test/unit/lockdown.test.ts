import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSafeCall,
  buildPlan,
  type Deps,
  describeRequests,
  execute,
  floorsOf,
  loadTable,
  main,
  meterNames,
  type Plan,
  parseCli,
  renderPlan,
  type Table,
  writeSql,
} from "../../tools/lockdown.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const table = loadTable();
const LEVELS = ["L1", "L2", "L3", "L4", "L5"];
const TOKEN = "cf-token-9f3a7c21";
const ACCOUNT = "acct-1b2c3d4e5f";
const GH_TOKEN = "gh-token-77aa11bb";
const NOW = 1_800_000_000_000;

const optionsFor = (level: string, undo = false) => ({
  level,
  undo,
  meter: level === "L1" ? "convert" : undefined,
});
const planFor = (level: string, undo = false) => buildPlan(table, optionsFor(level, undo));

// ---------- fakes ----------

/** A real SQLite (node:sqlite) with the two tables the tool writes, shaped as migration 0005 has them. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
    CREATE TABLE admin_action (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, admin_user_id TEXT, action TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, report_id TEXT);`);
  const argvs: string[][] = [];
  let fail = false;
  return {
    db,
    argvs,
    failNext: () => {
      fail = true;
    },
    run(cmd: string, args: string[]) {
      argvs.push([cmd, ...args]);
      if (fail) return { status: 1, stdout: "", stderr: "D1 is down" };
      const sql = args[args.indexOf("--command") + 1] ?? "";
      db.exec(sql);
      // changes() is the last statement's count: the log line, which exists only when the write took effect.
      const logged = db.prepare("SELECT changes() AS n").get() as { n: number };
      return { status: 0, stdout: JSON.stringify([{ meta: { changes: 1 } }, { meta: { changes: logged.n } }]) };
    },
    settings: () => db.prepare("SELECT key, value, updated_at, updated_by FROM setting ORDER BY key").all(),
    log: () => db.prepare("SELECT * FROM admin_action ORDER BY id").all(),
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** An in-memory Cloudflare and GitHub: enough of each endpoint the ops read and write. */
function fakeApi() {
  const calls: Call[] = [];
  const state = {
    ruleset: null as null | { id: string; rules: Record<string, unknown>[] },
    workersDev: true,
    crons: [{ cron: "0 * * * *" }, { cron: "30 3 * * *" }],
    instances: ["inst-a", "inst-b"],
    deployState: "active",
  };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const ok = (result: unknown) => reply(200, { success: true, result });
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "");
    if (u.host === "api.github.com") {
      if (method === "GET") return reply(200, { state: state.deployState });
      state.deployState = path.endsWith("/disable") ? "disabled_manually" : "active";
      return new Response(null, { status: 204 });
    }
    if (path === "/zones") return ok([{ id: "zone-1" }]);
    if (path.endsWith("/entrypoint")) {
      if (method === "GET")
        return state.ruleset
          ? ok(state.ruleset)
          : reply(404, { success: false, errors: [{ code: 10003, message: "none" }] });
      state.ruleset = {
        id: "rs-1",
        rules: (body as { rules: Record<string, unknown>[] }).rules.map((r, i) => ({ ...r, id: `rule-${i}` })),
      };
      return ok(state.ruleset);
    }
    if (/\/rulesets\/rs-1\/rules$/.test(path) && state.ruleset) {
      state.ruleset.rules.push({ ...(body as object), id: "rule-new" });
      return ok(state.ruleset);
    }
    const patch = path.match(/\/rulesets\/rs-1\/rules\/([\w-]+)$/);
    if (patch && state.ruleset) {
      state.ruleset.rules = state.ruleset.rules.map((r) => (r.id === patch[1] ? { ...(body as object), id: r.id } : r));
      return ok({});
    }
    if (path.endsWith("/subdomain")) {
      if (method === "POST") state.workersDev = (body as { enabled: boolean }).enabled;
      return ok({ enabled: state.workersDev });
    }
    if (path.endsWith("/schedules")) {
      if (method === "PUT") state.crons = body as typeof state.crons;
      return ok({ schedules: state.crons });
    }
    if (/\/instances\?status=running/.test(url)) return ok(state.instances.map((id) => ({ id })));
    if (/\/instances\?status=/.test(url)) return ok([]);
    if (/\/instances\/[\w-]+\/status$/.test(path)) {
      state.instances = state.instances.filter((id) => !path.includes(`/${id}/`));
      return ok({});
    }
    return reply(500, { success: false, errors: [{ code: 1, message: `unexpected ${method} ${path}` }] });
  };
  const mutating = () => calls.filter((c) => c.method !== "GET");
  return { calls, state, fetch: fetchFake as typeof fetch, mutating };
}

function deps(d1 = fakeD1(), api = fakeApi(), env: Deps["env"] = {}) {
  const full: Deps = {
    env: {
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      GITHUB_TOKEN: GH_TOKEN,
      GITHUB_REPOSITORY: "owner/repo",
      ...env,
    },
    fetch: api.fetch,
    run: (cmd, args) => d1.run(cmd, args),
    now: () => NOW,
  };
  return { d1, api, deps: full };
}

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

  it("every switch has allowed values, a default among them, and every write uses an allowed value", () => {
    for (const [name, spec] of Object.entries(table.switches)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(spec.values, name).toContain(spec.default);
    }
    const writes = [
      ...Object.values(table.rungs).flatMap((r) => r.writes),
      ...Object.entries(table.rungs.L1?.meters ?? {}).map(([switch_, value]) => ({ switch: switch_, value })),
    ];
    expect(writes.length).toBeGreaterThan(10);
    for (const w of writes) expect(table.switches[w.switch]?.values, w.switch).toContain(w.value);
  });

  it("every write is stricter than its switch default (a lockdown never loosens)", () => {
    const writes = [
      ...Object.values(table.rungs).flatMap((r) => r.writes),
      ...Object.entries(table.rungs.L1?.meters ?? {}).map(([switch_, value]) => ({ switch: switch_, value })),
    ];
    for (const w of writes) {
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

  it("the floors are SWITCH_<NAME>=value for every write", () => {
    expect(floorsOf(planFor("L2"))).toContainEqual({ name: "SWITCH_CONVERT", value: "off" });
    expect(floorsOf(planFor("L2"))).toHaveLength(7);
    expect(floorsOf(planFor("L2", true))).toEqual([]);
  });

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
    it(`${level}: the undo plan restores each write to its default and undoes each call or says how by hand`, () => {
      const set = planFor(level);
      const undo = planFor(level, true);
      expect(undo.undo).toBe(true);
      expect(undo.freeze.action).toBe("enable");
      expect(set.freeze.action).toBe("disable");
      expect(undo.writes.map((w) => w.switch)).toEqual(set.writes.map((w) => w.switch));
      for (const w of undo.writes) expect(w.value).toBe(table.switches[w.switch]?.default);
      const rungs = [level, table.rungs[level]?.includes].flatMap((l) => (l ? [l] : []));
      const calls = rungs.flatMap((l) => table.rungs[l]?.calls ?? []);
      const reversible = calls.filter((c) => "op" in c.undo).length;
      const byHand = calls.filter((c) => "manual" in c.undo).length;
      expect(undo.calls).toHaveLength(reversible);
      expect(undo.manual).toHaveLength(byHand);
    });
  }

  it("every call's undo is an op the table can describe, or a manual sentence", () => {
    for (const rung of Object.values(table.rungs)) {
      for (const call of rung.calls) {
        if ("op" in call.undo) expect(() => describeRequests(table, call.undo as never)).not.toThrow();
        else expect(call.undo.manual).toMatch(/\S/);
      }
    }
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
      ]) {
        expect(() => assertSafeCall(method, path), `${method} ${path}`).toThrow(/refused/);
      }
    }
  });

  it("allows reads and the subresources the ladder uses", () => {
    expect(() => assertSafeCall("GET", `${accounts}/workers/scripts/bloop`)).not.toThrow();
    for (const [method, path] of [
      ["POST", `${accounts}/workers/scripts/bloop/subdomain`],
      ["PUT", `${accounts}/workers/scripts/bloop/schedules`],
      ["POST", "/zones/z/rulesets/r/rules"],
      ["PATCH", "/zones/z/rulesets/r/rules/x"],
      ["PUT", "/zones/z/rulesets/phases/http_request_firewall_custom/entrypoint"],
      ["PATCH", `${accounts}/workflows/bloop-convert/instances/i/status`],
      ["PUT", "/repos/o/r/actions/workflows/deploy.yml/disable"],
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
        expect(result.failed, result.lines.join("\n")).toBe(false);
      }
    }
    expect(api.calls.length).toBeGreaterThan(20);
    for (const c of api.calls) {
      expect(c.method).not.toBe("DELETE");
      const path = new URL(c.url).pathname;
      expect(() => assertSafeCall(c.method, path), `${c.method} ${path}`).not.toThrow();
      expect(path).not.toMatch(/\/workers\/scripts\/bloop$/);
    }
    for (const argv of d1.argvs) expect(argv.slice(0, 4)).toEqual(["npx", "wrangler", "d1", "execute"]);
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

// ---------- dry run ----------

describe("dry run", () => {
  it("makes zero calls: no fetch, no wrangler, for every rung, set and undo", async () => {
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        const argv = ["--level", level, ...(level === "L1" ? ["--meter", "uploads"] : []), ...(undo ? ["--undo"] : [])];
        let used = 0;
        const guard: Deps = {
          env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, GITHUB_TOKEN: GH_TOKEN },
          fetch: (() => {
            used += 1;
            throw new Error("network in dry run");
          }) as never,
          run: () => {
            used += 1;
            throw new Error("spawn in dry run");
          },
          now: () => {
            used += 1;
            return NOW;
          },
        };
        const { code, out } = await main(argv, guard);
        expect(code, out).toBe(0);
        expect(used, `${level} ${undo}`).toBe(0);
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
    for (const secret of [TOKEN, ACCOUNT, GH_TOKEN]) {
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

// ---------- apply and idempotence ----------

describe("apply", () => {
  it("L2 writes seven rows and seven log lines with the actor lockdown", async () => {
    const { deps: d, d1 } = deps();
    const result = await execute(table, planFor("L2"), d);
    expect(result.failed).toBe(false);
    const rows = d1.settings() as { key: string; value: string; updated_by: string }[];
    expect(rows.map((r) => `${r.key}=${r.value}`).sort()).toEqual([
      "convert=off",
      "demo_drop=off",
      "email=admin_only",
      "export=off",
      "guest_drop=off",
      "previews=off",
      "uploads=readonly",
    ]);
    for (const r of rows) expect(r.updated_by).toBe("lockdown");
    const log = d1.log() as { admin_user_id: string; target_kind: string; at: number }[];
    expect(log).toHaveLength(7);
    for (const l of log) expect(l).toMatchObject({ admin_user_id: "lockdown", target_kind: "setting", at: NOW });
  });

  it("the wrangler call is parameter-free SQL through `d1 execute <db> --remote --command`", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L1"), d);
    const argv = d1.argvs[0] ?? [];
    expect(argv.slice(0, 7)).toEqual(["npx", "wrangler", "d1", "execute", "bloop", "--remote", "--json"]);
    expect(argv[7]).toBe("--command");
  });

  it("L3 raises email to off and adds convert_video", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L3"), d);
    const rows = Object.fromEntries((d1.settings() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(rows).toMatchObject({ email: "off", convert_video: "off", convert: "off" });
  });

  it("L4 adds the block rule once and turns workers.dev off; L5 clears the crons", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L5"), d);
    expect(api.state.ruleset?.rules).toHaveLength(1);
    expect(api.state.ruleset?.rules[0]).toMatchObject({ ref: "lockdown", action: "block", enabled: true });
    expect(api.state.workersDev).toBe(false);
    expect(api.state.crons).toEqual([]);
    expect(api.state.deployState).toBe("disabled_manually");
  });

  it("L3 terminates live Workflow instances", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L3"), d);
    expect(api.state.instances).toEqual([]);
  });

  it("an L4 undo disables the rule but keeps it, and turns workers.dev back on", async () => {
    const { deps: d, api } = deps();
    await execute(table, planFor("L4"), d);
    await execute(table, planFor("L4", true), d);
    expect(api.state.ruleset?.rules).toHaveLength(1);
    expect(api.state.ruleset?.rules[0]).toMatchObject({ enabled: false });
    expect(api.state.workersDev).toBe(true);
    expect(api.state.deployState).toBe("active");
  });

  it("an undo restores the defaults and logs it", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    await execute(table, planFor("L2", true), d);
    const rows = Object.fromEntries((d1.settings() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(rows).toMatchObject({ convert: "account_only", uploads: "on", email: "on", export: "on" });
    expect((d1.log() as { action: string }[]).filter((l) => l.action === "lockdown.undo")).toHaveLength(7);
  });
});

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
        const later = { ...d, now: () => NOW + 60_000 };
        const second = await execute(table, planFor(level, undo), later);
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
    expect(first.lines.join("\n")).toMatch(/D1 convert -> off: changed/);
    expect(second.lines.join("\n")).toMatch(/D1 convert -> off: unchanged/);
  });

  it("never loosens: a stricter row stands, and nothing is logged for it", async () => {
    const { deps: d, d1 } = deps();
    d1.db.exec("INSERT INTO setting VALUES ('uploads', 'off', 5, 'owner'), ('convert', 'garbage', 5, 'owner')");
    await execute(table, planFor("L2"), d);
    const rows = Object.fromEntries(
      (d1.settings() as { key: string; value: string; updated_by: string }[]).map((r) => [r.key, r]),
    );
    expect(rows.uploads).toMatchObject({ value: "off", updated_by: "owner" });
    expect(rows.convert).toMatchObject({ value: "garbage", updated_by: "owner" });
    expect((d1.log() as { target_id: string }[]).map((l) => l.target_id)).not.toContain("uploads");
    expect((d1.log() as { target_id: string }[]).map((l) => l.target_id)).not.toContain("convert");
  });

  it("an undo touches only rows lockdown wrote", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L2"), d);
    d1.db.exec("UPDATE setting SET value = 'off', updated_by = 'breaker' WHERE key = 'email'");
    await execute(table, planFor("L2", true), d);
    const rows = Object.fromEntries((d1.settings() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(rows.email).toBe("off");
    expect(rows.uploads).toBe("on");
  });

  it("a stricter L3 write replaces the L2 one, a looser one never replaces a stricter", async () => {
    const { deps: d, d1 } = deps();
    await execute(table, planFor("L3"), d);
    await execute(table, planFor("L2"), d);
    const rows = Object.fromEntries((d1.settings() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(rows.email).toBe("off");
  });
});

// ---------- SQL ----------

describe("SQL is built only from the table", () => {
  const ALLOWED = new Set<string>([
    "lockdown",
    "lockdown.set",
    "lockdown.undo",
    "setting",
    ...Object.keys(table.switches),
    ...Object.values(table.switches).flatMap((s) => s.values),
  ]);

  it("every quoted literal in every statement is a switch, a value, the actor or a fixed word, or the reason", () => {
    for (const level of LEVELS) {
      for (const undo of [false, true]) {
        for (const w of planFor(level, undo).writes) {
          for (const s of writeSql(table, w, { level, undo, now: NOW })) {
            for (const [, lit] of s.matchAll(/'([^']*)'/g)) {
              const text = lit ?? "";
              const reason = /^lockdown L[1-5]( undo)?: [a-z_]+=[a-z_]+$/.test(text);
              expect(ALLOWED.has(text) || reason, `${text} in ${s}`).toBe(true);
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
  it("apply needs both Cloudflare variables and says which is missing, never a value", async () => {
    const { deps: d } = deps(undefined, undefined, { CLOUDFLARE_API_TOKEN: undefined });
    const { code, out } = await main(["--level", "L2", "--apply"], d);
    expect(code).toBe(2);
    expect(out).toContain("CLOUDFLARE_API_TOKEN");
    expect(out).not.toContain(ACCOUNT);
  });

  it("no output of an apply holds a credential, even when an error echoes one", async () => {
    const { deps: d, d1 } = deps();
    d1.failNext();
    const failing: Deps = { ...d, run: () => ({ status: 1, stderr: `bad token ${TOKEN} for ${ACCOUNT}` }) };
    const { code, out } = await main(["--level", "L2", "--apply"], failing);
    expect(code).toBe(1);
    for (const secret of [TOKEN, ACCOUNT, GH_TOKEN]) expect(out).not.toContain(secret);
  });

  it("a D1 failure is reported, the other steps still run, and the var floors are printed", async () => {
    const { deps: d, d1, api } = deps();
    d1.failNext();
    const result = await execute(table, planFor("L3"), d);
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("SWITCH_CONVERT=off");
    expect(api.state.instances).toEqual([]);
  });

  it("without GitHub credentials the freeze is printed as a manual step, not skipped silently", async () => {
    const { deps: d } = deps(undefined, undefined, { GITHUB_TOKEN: undefined });
    const result = await execute(table, planFor("L2"), d);
    expect(result.failed).toBe(false);
    expect(result.lines.join("\n")).toMatch(/deploys \(deploy\.yml\): not done here/);
  });

  it("a failing API call fails the run and names the status only", async () => {
    const api = fakeApi();
    const broken = { ...api, fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch };
    const { deps: d } = deps(undefined, broken);
    const result = await execute(table, planFor("L4"), d);
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("answered 403");
  });

  it("the plan lists the permissions beyond the deploy token", () => {
    const l4: Plan = planFor("L4");
    expect(l4.permissions.filter((p) => !p.held).map((p) => p.name)).toEqual([
      "Zone Read and Zone WAF Edit on the zone",
    ]);
    expect(planFor("L2").permissions.every((p) => p.held)).toBe(true);
    expect(renderPlan(table, l4, false)).toContain("(extra)");
  });
});

// ---------- the workflow and the docs ----------

describe("lockdown.yml matches the table", () => {
  const yml = read(".github/workflows/lockdown.yml");
  const optionsOf = (input: string) => {
    const block = yml.split(new RegExp(`^      ${input}:\\n`, "m"))[1]?.split(/^      \w+:\n/m)[0] ?? "";
    const list = block.split(/^        options:\n/m)[1] ?? "";
    return [...list.matchAll(/^          - (\S+)$/gm)].map((m) => m[1]);
  };

  it("offers L1 to L5 and exactly the meters the table lists, plus none", () => {
    expect(optionsOf("level")).toEqual(LEVELS);
    expect(optionsOf("meter")).toEqual(["none", ...meterNames(table)]);
  });

  it("has boolean undo and apply, and apply defaults to false", () => {
    expect(yml).toMatch(/^      undo:\n(?:        .*\n)*?        type: boolean\n/m);
    const apply = yml.split(/^      apply:\n/m)[1]?.split(/^      \w+:\n|^\S/m)[0] ?? "";
    expect(apply).toContain("type: boolean");
    expect(apply).toMatch(/default: false/);
    expect(yml.split(/^      undo:\n/m)[1]?.split(/^      \w+:\n/m)[0]).toMatch(/default: false/);
  });

  it("is dispatch only, scoped to actions write, and reads the secrets deploy.yml reads", () => {
    expect(yml).toMatch(/^on:\n  workflow_dispatch:/m);
    expect(yml).not.toMatch(/^  (push|pull_request|schedule):/m);
    expect(yml).toMatch(/^permissions:\n  contents: read\n  actions: write\n/m);
    expect(yml).toContain("environment: production");
    expect(yml).toContain("if: github.ref == 'refs/heads/main'");
    expect(yml).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(yml).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(yml).toContain("secrets.GITHUB_TOKEN");
  });

  it("pins every action by SHA with a version comment, as the other workflows do", () => {
    const uses = [...yml.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const [, spec, rest] of uses) {
      expect(spec).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/# v\d/);
    }
    const pinned = (file: string) =>
      new Map([...read(file).matchAll(/uses: ([\w-]+\/[\w-]+@[0-9a-f]{40})/g)].map((m) => [m[1]?.split("@")[0], m[1]]));
    const deploy = pinned(".github/workflows/deploy.yml");
    for (const [, spec] of uses) expect(deploy.get(spec?.split("@")[0]), spec).toBe(spec);
  });

  it("passes inputs through env, never interpolated into the script", () => {
    const run = yml.split(/^\s+run: \|\n/m)[1] ?? "";
    expect(run).not.toContain("${{");
    for (const key of ["LEVEL", "METER", "UNDO", "APPLY"])
      expect(yml).toContain(`${key}: \${{ inputs.${key.toLowerCase()} }}`);
    expect(yml).toContain("node tools/lockdown.mjs");
    expect(yml).toContain("GITHUB_STEP_SUMMARY");
  });
});

describe("docs", () => {
  const docs = read("docs/lockdown.md");
  it("covers every rung, the phone, the Mac, undo and the token permissions", () => {
    for (const level of LEVELS) expect(docs).toContain(`### ${level}`);
    for (const word of ["phone", "mac", "undo", "token", "workflow_dispatch"])
      expect(docs.toLowerCase()).toContain(word);
  });

  it("names every extra permission the table says a rung lacks", () => {
    const extra = new Set(
      Object.values(table.rungs).flatMap((r) => r.calls.filter((c) => !c.held).map((c) => c.permission)),
    );
    expect(extra.size).toBeGreaterThan(0);
    for (const permission of extra) expect(docs, permission).toContain(permission);
  });

  it("links to the spend docs for the switch names rather than listing their meaning", () => {
    expect(docs).toContain("(spend.md)");
    expect(docs).not.toMatch(/[–—]/);
  });

  it("ADR 0030 says why, what it replaces and how to remove it", () => {
    const adr = read("docs/adr/0030-lockdown.md");
    for (const word of ["Context", "Decision", "Replaces", "Remove"]) expect(adr).toContain(word);
    expect(adr).not.toMatch(/[–—]/);
  });
});
