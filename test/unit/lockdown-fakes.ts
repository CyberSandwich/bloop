import { DatabaseSync } from "node:sqlite";
import { type Deps, loadTable, wranglerSettings } from "../../tools/lockdown.mjs";

export const TOKEN = "cf-deploy-9f3a7c21";
export const LOCK_TOKEN = "cf-lockdown-55e0b8d4";
export const ACCOUNT = "acct-1b2c3d4e5f";
export const GH_TOKEN = "gh-token-77aa11bb";
export const NOW = 1_800_000_000_000;
export const table = loadTable();

/** A real SQLite (node:sqlite) with the two tables the tool writes, shaped as migration 0005 has them. */
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
    CREATE TABLE admin_action (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, admin_user_id TEXT, action TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, report_id TEXT);`);
  const argvs: string[][] = [];
  const envs: Record<string, string>[] = [];
  let fail = false;
  return {
    db,
    argvs,
    envs,
    failNext: () => {
      fail = true;
    },
    /** Like wrangler's remote output: one result per statement, each with the rows it changed. */
    run(cmd: string, args: string[], env: Record<string, string> = {}) {
      argvs.push([cmd, ...args]);
      envs.push(env);
      if (fail) return { status: 1, stdout: "", stderr: "D1 is down" };
      const sql = args[args.indexOf("--command") + 1] ?? "";
      const results = sql
        .split(/;\n|;$/)
        .filter((s) => s.trim())
        .map((statement) => {
          db.exec(`${statement};`);
          const n = db.prepare("SELECT changes() AS n").get() as { n: number };
          return { success: true, meta: { changes: n.n } };
        });
      return { status: 0, stdout: JSON.stringify(results) };
    },
    settings: () => db.prepare("SELECT key, value, updated_at, updated_by FROM setting ORDER BY key").all(),
    rows: () =>
      Object.fromEntries(
        (
          db.prepare("SELECT key, value, updated_by FROM setting").all() as {
            key: string;
            value: string;
            updated_by: string;
          }[]
        ).map((r) => [r.key, r]),
      ),
    log: () =>
      db.prepare("SELECT * FROM admin_action ORDER BY id").all() as {
        id: number;
        at: number;
        admin_user_id: string;
        action: string;
        target_kind: string;
        target_id: string;
        reason: string;
      }[],
  };
}

export interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string;
}

interface Instance {
  id: string;
  status: string;
}

/** An in-memory Cloudflare and GitHub: enough of each endpoint the ops read and write. */
export function fakeApi() {
  const calls: Call[] = [];
  const state = {
    ruleset: null as null | { id: string; rules: Record<string, unknown>[] },
    workersDev: { enabled: true, previews_enabled: false },
    crons: wranglerSettings().crons.map((cron) => ({ cron })),
    instances: [
      { id: "inst-a", status: "running" },
      { id: "inst-b", status: "running" },
    ] as Instance[],
    pageSize: 100,
    /** Status the batch endpoint answers instead of working. */
    batchStatus: 0,
    /** The batch endpoint answers 429 this many times first. */
    rateLimited: 0,
    patchFails: new Set<string>(),
    /** A terminated instance still shows as running for this many full looks. */
    lag: 0,
    zombies: [] as { id: string; looksLeft: number }[],
    /** Instances that stay live however often they are terminated. */
    sticky: new Set<string>(),
    deployState: "active",
    runs: [] as { id: number; status: string }[],
    verify: "active",
    /** Path fragments that answer 403. */
    denied: [] as string[],
    githubFails: false,
    /** What the live site's /api/health answers; 0 means the request fails outright. */
    site: 200,
  };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => reply(200, { success: true, result, ...extra });
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    calls.push({ method, url, body, auth });
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "");
    if (u.host === table.zone) {
      if (!state.site) throw new TypeError("fetch failed");
      return state.site === 200 ? reply(200, { status: "ok" }) : reply(state.site, { error: "blocked" });
    }
    if (u.host === "api.github.com") {
      if (state.githubFails) return reply(500, { message: "down" });
      const cancel = path.match(/\/actions\/runs\/(\d+)\/cancel$/);
      if (cancel) {
        state.runs = state.runs.filter((r) => r.id !== Number(cancel[1]));
        return new Response(null, { status: 202 });
      }
      if (path.endsWith("/runs")) {
        const status = u.searchParams.get("status");
        return reply(200, { workflow_runs: state.runs.filter((r) => r.status === status) });
      }
      if (method === "GET") return reply(200, { state: state.deployState });
      state.deployState = path.endsWith("/disable") ? "disabled_manually" : "active";
      return new Response(null, { status: 204 });
    }
    if (state.denied.some((fragment) => path.includes(fragment))) {
      return reply(403, { success: false, errors: [{ code: 9109, message: "Unauthorized" }] });
    }
    if (path.endsWith("/tokens/verify")) return ok({ status: state.verify });
    if (path === "/zones") return ok([{ id: "zone-1" }]);
    if (path.endsWith("/d1/database")) return ok([]);
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
      if (method === "POST") state.workersDev = body as typeof state.workersDev;
      return ok(state.workersDev);
    }
    if (path.endsWith("/schedules")) {
      if (method === "PUT") state.crons = body as typeof state.crons;
      return ok({ schedules: state.crons });
    }
    if (path.endsWith("/instances/batch/terminate")) {
      if (state.rateLimited > 0) {
        state.rateLimited -= 1;
        return reply(429, { success: false, errors: [{ code: 971, message: "slow down" }] }, { "retry-after": "1" });
      }
      if (state.batchStatus)
        return reply(state.batchStatus, { success: false, errors: [{ code: 1, message: "batch" }] });
      const ids = body as string[];
      for (const id of ids)
        if (state.lag > 0 && !state.sticky.has(id)) state.zombies.push({ id, looksLeft: state.lag });
      state.instances = state.instances.filter((i) => !ids.includes(i.id) || state.sticky.has(i.id));
      return ok({});
    }
    if (/\/instances\/[\w-]+\/status$/.test(path)) {
      const id = path.split("/").at(-2) ?? "";
      if (state.patchFails.has(id)) return reply(500, { success: false, errors: [{ code: 1, message: "patch" }] });
      state.instances = state.instances.filter((i) => i.id !== id || state.sticky.has(id));
      return ok({});
    }
    if (path.endsWith("/instances")) {
      const status = u.searchParams.get("status");
      const start = Number(u.searchParams.get("cursor") ?? 0);
      // The first status a look asks about is queued: that is when a zombie ages by one look.
      if (status === "queued") for (const z of state.zombies) z.looksLeft -= 1;
      const of = [
        ...state.instances.filter((i) => i.status === status),
        ...(status === "running"
          ? state.zombies.filter((z) => z.looksLeft > 0).map((z) => ({ id: z.id, status }))
          : []),
      ];
      const page = of.slice(start, start + state.pageSize);
      const more = start + state.pageSize < of.length;
      return ok(page, { result_info: more ? { cursor: String(start + state.pageSize) } : {} });
    }
    return reply(500, { success: false, errors: [{ code: 1, message: `unexpected ${method} ${path}` }] });
  };
  const mutating = () => calls.filter((c) => c.method !== "GET");
  return { calls, state, fetch: fetchFake as typeof fetch, mutating };
}

export function deps(
  d1 = fakeD1(),
  api = fakeApi(),
  env: Deps["env"] = {},
  settings = { crons: wranglerSettings().crons, previews: false },
) {
  const slept: number[] = [];
  const full: Deps = {
    env: {
      LOCKDOWN_CF_TOKEN: LOCK_TOKEN,
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      GITHUB_TOKEN: GH_TOKEN,
      GITHUB_REPOSITORY: "owner/repo",
      ...env,
    },
    fetch: api.fetch,
    run: (cmd, args, e) => d1.run(cmd, args, e),
    now: () => NOW,
    sleep: async (ms) => {
      slept.push(ms);
    },
    wrangler: () => settings,
  };
  return { d1, api, deps: full, slept };
}
