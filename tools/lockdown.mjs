// The incident ladder from a terminal or from .github/workflows/lockdown.yml: one rung table (lockdown-rungs.json),
// a dry run by default, an undo for every rung. docs/lockdown.md says what each rung does and what it needs.
// Safety is code, not convention: nothing here deletes, and no request can touch the Worker's code, its Durable Object
// classes, a bucket or a database (assertSafeCall). SQL is built only from the table's names and values.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** @typedef {{values: string[], default: string}} SwitchSpec */
/** @typedef {{switch: string, value: string}} Write */
/** @typedef {{op: string, params: Record<string, unknown>} | {manual: string}} Undo */
/** @typedef {{id: string, op: string, params: Record<string, unknown>, permission: string, held: boolean, undo: Undo}} Call */
/** @typedef {{title: string, mechanism: string, includes?: string, meters?: Record<string, string>, writes: Write[], calls: Call[], manual: string[], undo: {summary: string}}} Rung */
/** @typedef {{database: string, worker: string, zone: string, workflow: string, deployWorkflow: string, actor: string, wafRef: string, held: string[], switches: Record<string, SwitchSpec>, rungs: Record<string, Rung>}} Table */
/** @typedef {{level: string, undo: boolean, meter?: string | undefined}} Options */
/** @typedef {{action: "disable" | "enable", workflow: string}} Freeze */
/** @typedef {{switch: string, value: string, from?: string}} PlanWrite */
/** @typedef {{id: string, op: string, params: Record<string, unknown>, permission: string, held: boolean}} PlanCall */
/** @typedef {{level: string, undo: boolean, title: string, summary: string, freeze: Freeze, writes: PlanWrite[], calls: PlanCall[], manual: string[], permissions: {name: string, held: boolean}[]}} Plan */
/** @typedef {{status: number | null, stdout?: string, stderr?: string}} RunResult */
/** @typedef {{env: Record<string, string | undefined>, fetch: typeof fetch, run: (cmd: string, args: string[]) => RunResult, now: () => number}} Deps */

const TABLE_URL = new URL("./lockdown-rungs.json", import.meta.url);
const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";
const SQL_TOKEN = /^[A-Za-z0-9_ =:.-]*$/;
const NAME = /^[a-z][a-z0-9_.-]*$/;

/** @returns {Table} */
export const loadTable = () => JSON.parse(readFileSync(TABLE_URL, "utf8"));

/** The meter switches L1 accepts, in table order. @param {Table} table */
export const meterNames = (table) => Object.keys(table.rungs.L1?.meters ?? {});

/** The Worker variable that holds a switch at a value when D1 is unreachable (docs/spend.md owns the rule). @param {string} name */
const floorVar = (name) => `SWITCH_${name.toUpperCase()}`;

/**
 * A rung with its `includes` chain merged, earlier rungs first; a later write to the same switch replaces the earlier.
 * @param {Table} table
 * @param {string} level
 * @returns {{writes: Write[], calls: Call[], manual: string[]}}
 */
function merged(table, level) {
  const rung = table.rungs[level];
  if (!rung) throw new Error(`unknown level ${level}`);
  const base = rung.includes ? merged(table, rung.includes) : { writes: [], calls: [], manual: [] };
  const writes = new Map(base.writes.map((w) => [w.switch, w]));
  for (const w of rung.writes) writes.set(w.switch, w);
  return {
    writes: [...writes.values()],
    calls: [...base.calls, ...rung.calls],
    manual: [...base.manual, ...rung.manual],
  };
}

/**
 * @param {Table} table
 * @param {string} name
 * @param {string} value
 */
function assertAllowed(table, name, value) {
  const spec = Object.hasOwn(table.switches, name) ? table.switches[name] : undefined;
  if (!spec) throw new Error(`switch ${JSON.stringify(name)} is not allowlisted`);
  if (!spec.values.includes(value)) throw new Error(`value ${JSON.stringify(value)} is not allowed for ${name}`);
  return spec;
}

/**
 * @param {Table} table
 * @param {Options} opts
 * @returns {Plan}
 */
export function buildPlan(table, opts) {
  const { level, undo } = opts;
  const rung = table.rungs[level];
  if (!rung) throw new Error(`unknown level ${level} (L1 to L5)`);
  const all = merged(table, level);
  /** @type {Write[]} */
  let writes = all.writes;
  if (level === "L1") {
    const meters = rung.meters ?? {};
    if (!opts.meter || !Object.hasOwn(meters, opts.meter)) {
      throw new Error(`L1 needs --meter, one of: ${meterNames(table).join(", ")}`);
    }
    writes = [{ switch: opts.meter, value: /** @type {string} */ (meters[opts.meter]) }];
  } else if (opts.meter) {
    throw new Error("--meter applies to L1 only");
  }
  for (const w of writes) assertAllowed(table, w.switch, w.value);

  /** @type {PlanWrite[]} */
  const planWrites = writes.map((w) =>
    undo
      ? { switch: w.switch, value: /** @type {SwitchSpec} */ (table.switches[w.switch]).default, from: w.value }
      : { switch: w.switch, value: w.value },
  );
  /** @type {PlanCall[]} */
  const calls = [];
  const manual = undo ? [] : [...all.manual];
  for (const c of undo ? [...all.calls].reverse() : all.calls) {
    const { id, permission, held } = c;
    if (!undo) calls.push({ id, op: c.op, params: c.params, permission, held });
    else if ("op" in c.undo) calls.push({ id: `${id}-undo`, op: c.undo.op, params: c.undo.params, permission, held });
    else manual.push(c.undo.manual);
  }
  const names = new Map(
    [
      ...(writes.length ? table.held.map((name) => ({ name, held: true })) : []),
      ...calls.map((c) => ({ name: c.permission, held: c.held })),
    ].map((p) => [p.name, p]),
  );
  return {
    level,
    undo,
    title: rung.title,
    summary: undo ? rung.undo.summary : rung.title,
    freeze: { action: undo ? "enable" : "disable", workflow: table.deployWorkflow },
    writes: planWrites,
    calls,
    manual,
    permissions: [...names.values()],
  };
}

/** The Worker variable floors that hold the plan's writes with D1 down (a set, never an undo). @param {Plan} plan */
export const floorsOf = (plan) =>
  plan.undo ? [] : plan.writes.map((w) => ({ name: floorVar(w.switch), value: w.value }));

/** @param {string} text */
function lit(text) {
  if (!SQL_TOKEN.test(text)) throw new Error("refusing to put an unexpected character in SQL");
  return `'${text}'`;
}

/**
 * Two statements per write: the write, then the log line, which exists only when this very run's write took effect
 * (same predicate as the write, so a second run logs nothing). A set never loosens: it replaces a row only with a
 * strictly stricter value, an unknown stored value counting as the strictest. An undo touches only rows this tool wrote.
 * @param {Table} table
 * @param {PlanWrite} write
 * @param {{level: string, undo: boolean, now: number}} ctx
 * @returns {string[]}
 */
export function writeSql(table, write, { level, undo, now }) {
  const spec = assertAllowed(table, write.switch, write.value);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("now must be a positive integer (epoch ms)");
  if (!/^L[1-5]$/.test(level)) throw new Error("bad level");
  const key = lit(write.switch);
  const value = lit(write.value);
  const actor = lit(table.actor);
  /** @param {string} column */
  const rank = (column) =>
    `CASE ${column} ${spec.values.map((v, i) => `WHEN ${lit(v)} THEN ${i}`).join(" ")} ELSE ${spec.values.length} END`;
  const change = undo
    ? `UPDATE setting SET value = ${value}, updated_at = ${now}, updated_by = ${actor} WHERE key = ${key} AND updated_by = ${actor} AND value != ${value};`
    : `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (${key}, ${value}, ${now}, ${actor}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by WHERE ${rank("setting.value")} < ${rank("excluded.value")};`;
  const reason = lit(`${table.actor} ${level}${undo ? " undo" : ""}: ${write.switch}=${write.value}`);
  const log = `INSERT INTO admin_action (at, admin_user_id, action, target_kind, target_id, reason) SELECT ${now}, ${actor}, ${lit(undo ? "lockdown.undo" : "lockdown.set")}, 'setting', ${key}, ${reason} WHERE EXISTS (SELECT 1 FROM setting WHERE key = ${key} AND value = ${value} AND updated_at = ${now} AND updated_by = ${actor});`;
  return [change, log];
}

/** The wrangler argv for one write. @param {Table} table @param {string[]} statements */
const wranglerArgs = (table, statements) => [
  "wrangler",
  "d1",
  "execute",
  table.database,
  "--remote",
  "--json",
  "--command",
  statements.join(" "),
];

/**
 * Refuses any request that could delete or rewrite what the ladder must keep. Reads always pass.
 * @param {string} method
 * @param {string} path the URL path after the API base, query allowed
 */
export function assertSafeCall(method, path) {
  const m = method.toUpperCase();
  if (m === "GET") return;
  const clean = path.split("?")[0] ?? "";
  if (m === "DELETE") throw new Error(`refused: DELETE ${clean}`);
  const github = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[\w.-]+\/(enable|disable)$/.test(clean);
  if (github && m === "PUT") return;
  // Buckets, databases, Durable Object classes and containers are never written from here.
  if (/\/(r2\/buckets|d1\/database|durable_objects|containers)(\/|$)/.test(clean))
    throw new Error(`refused: ${m} ${clean}`);
  // A script upload or rewrite (deploy) is how a Durable Object class gets dropped: only subresources are allowed.
  if (
    /\/workers\/(services\/[^/]+|scripts\/[^/]+(\/(content|versions|deployments|settings|secrets|assets-upload-session|tail))?)\/?$/.test(
      clean,
    )
  ) {
    throw new Error(`refused: ${m} ${clean}`);
  }
}

/**
 * The requests an op makes, for the dry run and for the safety test. `{account}` and the like stay as placeholders.
 * @param {Table} table
 * @param {{op: string, params: Record<string, unknown>}} call
 * @returns {{method: string, path: string, note: string}[]}
 */
export function describeRequests(table, { op, params }) {
  const acct = "/accounts/{account}";
  const script = `${acct}/workers/scripts/${table.worker}`;
  switch (op) {
    case "wafRule": {
      const set = params.enabled === true;
      const rules = "/zones/{zone}/rulesets";
      return [
        { method: "GET", path: `/zones?name=${table.zone}&account.id={account}`, note: "find the zone" },
        { method: "GET", path: `${rules}/phases/http_request_firewall_custom/entrypoint`, note: "find the rule" },
        ...(set
          ? [
              { method: "POST", path: `${rules}/{ruleset}/rules`, note: `add a block rule on the ${table.zone} host` },
              { method: "PATCH", path: `${rules}/{ruleset}/rules/{rule}`, note: "or enable the kept rule" },
            ]
          : [{ method: "PATCH", path: `${rules}/{ruleset}/rules/{rule}`, note: "disable the rule (it is kept)" }]),
      ];
    }
    case "workersDev":
      return [
        { method: "GET", path: `${script}/subdomain`, note: "read the workers.dev state" },
        { method: "POST", path: `${script}/subdomain`, note: `workers.dev ${params.enabled ? "on" : "off"}` },
      ];
    case "clearSchedules":
      return [
        { method: "GET", path: `${script}/schedules`, note: "read the cron triggers" },
        { method: "PUT", path: `${script}/schedules`, note: "set no cron triggers" },
      ];
    case "terminateWorkflows":
      return [
        {
          method: "GET",
          path: `${acct}/workflows/${table.workflow}/instances?status={state}`,
          note: "list live instances",
        },
        { method: "PATCH", path: `${acct}/workflows/${table.workflow}/instances/{id}/status`, note: "terminate each" },
      ];
    default:
      throw new Error(`unknown op ${op}`);
  }
}

/** @param {Plan} plan */
const freezeLine = (plan) => {
  const { action, workflow } = plan.freeze;
  return `PUT /repos/{repo}/actions/workflows/${workflow}/${action}`;
};

/**
 * The exact plan as text. Placeholders stand for ids; no secret value is ever in it.
 * @param {Table} table
 * @param {Plan} plan
 * @param {boolean} applying
 */
export function renderPlan(table, plan, applying) {
  /** @type {string[]} */
  const out = [];
  out.push(`${plan.level} ${plan.undo ? "UNDO" : "lockdown"}: ${plan.summary}`);
  out.push(applying ? "mode: APPLY" : "mode: dry run (nothing changes; add --apply)");
  out.push("", `1. ${plan.freeze.action === "disable" ? "Freeze" : "Unfreeze"} deploys`, `   ${freezeLine(plan)}`);
  out.push("", "2. D1 setting rows (npx wrangler d1 execute, remote)");
  if (plan.writes.length === 0) out.push("   none");
  const now = 1234567890123;
  for (const w of plan.writes) {
    out.push(`   ${w.switch} -> ${w.value}${w.from ? ` (only if lockdown set it; it set ${w.from})` : ""}`);
    for (const s of writeSql(table, w, { level: plan.level, undo: plan.undo, now }))
      out.push(`     ${s.replaceAll(String(now), "<now>")}`);
  }
  const floors = floorsOf(plan);
  if (floors.length) {
    out.push(
      "",
      "   If D1 is unreachable, the same effect as Worker variables (set by hand, then commit to wrangler.jsonc):",
    );
    for (const f of floors) out.push(`     ${f.name}=${f.value}`);
  }
  out.push("", "3. Cloudflare API");
  if (plan.calls.length === 0) out.push("   none");
  for (const c of plan.calls) {
    out.push(`   ${c.id} (needs ${c.permission}${c.held ? ", held" : ", NOT held by the deploy token"})`);
    for (const r of describeRequests(table, c)) out.push(`     ${r.method} ${r.path}  ${r.note}`);
  }
  out.push("", "4. By hand");
  if (plan.manual.length === 0) out.push("   none");
  for (const m of plan.manual) out.push(`   - ${m}`);
  out.push(
    "",
    `Token permissions: ${plan.permissions.map((p) => `${p.name}${p.held ? "" : " (extra)"}`).join("; ") || "none"}`,
  );
  return out.join("\n");
}

class ApiError extends Error {}

/**
 * @param {Deps} deps
 * @param {string} base
 * @param {Record<string, string>} headers
 */
function client(deps, base, headers) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {number[]} [accept] extra statuses that are an answer, not an error
   * @returns {Promise<{status: number, json: any, result: any}>}
   */
  return async (method, path, body, accept = []) => {
    assertSafeCall(method, path);
    const res = await deps.fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    /** @type {any} */
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body is reported by status alone.
    }
    if (accept.includes(res.status)) return { status: res.status, json, result: json.result };
    if (!res.ok || json.success === false) {
      const codes = (json.errors ?? []).map((/** @type {any} */ e) => `${e.code}: ${e.message}`).join("; ");
      throw new ApiError(`${method} ${path.split("?")[0]} answered ${res.status}${codes ? ` (${codes})` : ""}`);
    }
    return { status: res.status, json, result: json.result };
  };
}

/** @typedef {ReturnType<typeof client>} Api */

/** The block rule the WAF op adds, keyed by `wafRef` so a second run finds it. @param {Table} table */
const blockRule = (table) => ({
  ref: table.wafRef,
  description: table.wafRef,
  expression: `(http.host eq "${table.zone}")`,
  action: "block",
  enabled: true,
});

/**
 * Each op reads first and writes only on a difference, so a second run changes nothing.
 * @type {Record<string, (cf: Api, table: Table, account: string, params: Record<string, unknown>) => Promise<string>>}
 */
const OPS = {
  async wafRule(cf, table, account, params) {
    const want = params.enabled === true;
    const zones = await cf(
      "GET",
      `/zones?name=${encodeURIComponent(table.zone)}&account.id=${encodeURIComponent(account)}`,
    );
    const zone = zones.result?.[0]?.id;
    if (!zone) throw new ApiError(`zone ${table.zone} not found for this token`);
    const phase = `/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;
    const entry = await cf("GET", phase, undefined, [404]);
    const ruleset = entry.status === 404 ? undefined : entry.result;
    const rule = (ruleset?.rules ?? []).find((/** @type {any} */ r) => r.ref === table.wafRef);
    if (want) {
      if (rule?.enabled) return "unchanged: block rule already on";
      if (rule) {
        await cf("PATCH", `/zones/${zone}/rulesets/${ruleset.id}/rules/${rule.id}`, { ...blockRule(table) });
        return "changed: block rule enabled";
      }
      if (ruleset)
        await cf("POST", `/zones/${zone}/rulesets/${ruleset.id}/rules`, {
          ...blockRule(table),
          position: { index: 1 },
        });
      else await cf("PUT", phase, { rules: [blockRule(table)] });
      return "changed: block rule added";
    }
    if (!rule || !rule.enabled) return "unchanged: block rule already off";
    await cf("PATCH", `/zones/${zone}/rulesets/${ruleset.id}/rules/${rule.id}`, {
      ...blockRule(table),
      enabled: false,
    });
    return "changed: block rule disabled (kept)";
  },

  async workersDev(cf, table, account, params) {
    const want = params.enabled === true;
    const path = `/accounts/${account}/workers/scripts/${table.worker}/subdomain`;
    const now = await cf("GET", path);
    if ((now.result?.enabled === true) === want) return `unchanged: workers.dev already ${want ? "on" : "off"}`;
    await cf("POST", path, { enabled: want });
    return `changed: workers.dev ${want ? "on" : "off"}`;
  },

  async clearSchedules(cf, table, account) {
    const path = `/accounts/${account}/workers/scripts/${table.worker}/schedules`;
    const now = await cf("GET", path);
    const crons = now.result?.schedules ?? [];
    if (crons.length === 0) return "unchanged: no cron triggers";
    await cf("PUT", path, []);
    return `changed: ${crons.length} cron trigger(s) cleared`;
  },

  async terminateWorkflows(cf, table, account) {
    const base = `/accounts/${account}/workflows/${table.workflow}/instances`;
    let ended = 0;
    for (const state of ["running", "queued", "waiting"]) {
      const list = await cf("GET", `${base}?status=${state}&per_page=100`, undefined, [404]);
      if (list.status === 404) return "unchanged: no such workflow";
      for (const inst of list.result ?? []) {
        await cf("PATCH", `${base}/${encodeURIComponent(inst.id)}/status`, { status: "terminate" });
        ended += 1;
      }
    }
    return ended ? `changed: ${ended} instance(s) terminated` : "unchanged: no live instances";
  },
};

const CREDENTIALS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/** Every secret value in the environment, replaced in anything printed. @param {Deps["env"]} env @param {string} text */
const redact = (env, text) =>
  ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GITHUB_TOKEN"].reduce((t, k) => {
    const v = env[k];
    return v && v.length >= 6 ? t.split(v).join("***") : t;
  }, text);

/**
 * Runs one write through wrangler. The log statement's change count says whether this run changed the row.
 * @param {Table} table
 * @param {Deps} deps
 * @param {string[]} statements
 */
function runD1(table, deps, statements) {
  const res = deps.run("npx", wranglerArgs(table, statements));
  if (res.status !== 0) {
    const why = (res.stderr || res.stdout || "").trim().split("\n").find(Boolean) ?? "no output";
    throw new Error(`wrangler exited ${res.status}: ${why.slice(0, 300)}`);
  }
  try {
    const parsed = JSON.parse(res.stdout ?? "");
    const last = Array.isArray(parsed) ? parsed.at(-1) : undefined;
    return (last?.meta?.changes ?? 0) > 0 ? "changed" : "unchanged";
  } catch {
    return "ran (change count unavailable)";
  }
}

/**
 * Applies the plan: freeze, D1 rows, Cloudflare calls, then the by-hand list (an undo runs in the reverse order, so
 * deploys come back last). A failed step is reported and the rest still run; a failed D1 write prints the var floors.
 * @param {Table} table
 * @param {Plan} plan
 * @param {Deps} deps
 * @returns {Promise<{lines: string[], failed: boolean}>}
 */
export async function execute(table, plan, deps) {
  const env = deps.env;
  if (plan.writes.length > 0 || plan.calls.length > 0) {
    const missing = CREDENTIALS.filter((k) => !env[k]);
    if (missing.length) throw new Error(`set ${missing.join(" and ")} in the environment`);
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const cf = client(deps, CF, { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN ?? ""}` });
  const now = deps.now();
  /** @type {string[]} */
  const lines = [`${plan.level} ${plan.undo ? "UNDO" : "lockdown"}: ${plan.summary}`];
  let failed = false;
  /** @param {string} label @param {() => Promise<string> | string} run */
  const step = async (label, run) => {
    try {
      lines.push(`${label}: ${await run()}`);
    } catch (e) {
      failed = true;
      lines.push(`${label}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const freeze = () =>
    step(`${plan.freeze.action} deploys (${plan.freeze.workflow})`, async () => {
      const repo = env.GITHUB_REPOSITORY;
      const token = env.GITHUB_TOKEN;
      if (!repo || !token) {
        return `not done here (no GITHUB_TOKEN or GITHUB_REPOSITORY): by hand, Actions, ${plan.freeze.workflow}, the ... menu, ${plan.freeze.action === "disable" ? "Disable" : "Enable"} workflow`;
      }
      const gh = client(deps, GH, {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      const path = `/repos/${repo}/actions/workflows/${plan.freeze.workflow}`;
      const active = (await gh("GET", path)).json?.state === "active";
      if (active === (plan.freeze.action === "enable")) return `unchanged: already ${active ? "enabled" : "disabled"}`;
      await gh("PUT", `${path}/${plan.freeze.action}`);
      return `changed: workflow ${plan.freeze.action}d`;
    });

  const rows = async () => {
    for (const w of plan.writes) {
      await step(`D1 ${w.switch} -> ${w.value}`, () =>
        runD1(table, deps, writeSql(table, w, { level: plan.level, undo: plan.undo, now })),
      );
    }
    const floors = floorsOf(plan);
    if (floors.length && lines.some((l) => l.startsWith("D1 ") && l.includes("FAILED"))) {
      lines.push("D1 failed: set these Worker variables by hand, then commit them to wrangler.jsonc:");
      for (const f of floors) lines.push(`  ${f.name}=${f.value}`);
    }
  };

  const api = async () => {
    for (const c of plan.calls) {
      const op = OPS[c.op];
      await step(c.id, () => (op ? op(cf, table, account, c.params) : Promise.reject(new Error(`unknown op ${c.op}`))));
    }
  };

  if (plan.undo) {
    await api();
    await rows();
    await freeze();
  } else {
    await freeze();
    await rows();
    await api();
  }
  if (plan.manual.length) {
    lines.push("By hand:");
    for (const m of plan.manual) lines.push(`  - ${m}`);
  }
  return { lines: lines.map((l) => redact(env, l)), failed };
}

const USAGE = `usage: node tools/lockdown.mjs --level L1..L5 [--meter <switch>] [--undo] [--apply]
  Dry run unless --apply. L1 needs --meter. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to apply.
  GITHUB_TOKEN and GITHUB_REPOSITORY (set in Actions) let it freeze deploys; without them it prints the step.`;

/** @param {string[]} argv */
export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      level: { type: "string" },
      meter: { type: "string" },
      undo: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return {
    help: values.help === true,
    apply: values.apply === true,
    options: { level: values.level ?? "", undo: values.undo === true, meter: values.meter },
  };
}

/**
 * @param {string[]} argv
 * @param {Deps} deps
 * @returns {Promise<{code: number, out: string}>}
 */
export async function main(argv, deps) {
  try {
    const cli = parseCli(argv);
    if (cli.help) return { code: 0, out: USAGE };
    const table = loadTable();
    const plan = buildPlan(table, cli.options);
    if (!cli.apply) return { code: 0, out: renderPlan(table, plan, false) };
    const { lines, failed } = await execute(table, plan, deps);
    return { code: failed ? 1 : 0, out: lines.join("\n") };
  } catch (e) {
    return { code: 2, out: `lockdown: ${redact(deps.env, e instanceof Error ? e.message : String(e))}\n${USAGE}` };
  }
}

// realpath on both sides: a symlinked path to this file must still run the CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { code, out } = await main(process.argv.slice(2), {
    env: process.env,
    fetch,
    run: (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env: process.env, timeout: 120_000 }),
    now: Date.now,
  });
  console.log(out);
  process.exitCode = code;
}
