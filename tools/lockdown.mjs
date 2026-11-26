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
/** @typedef {{database: string, worker: string, zone: string, workflow: string, deployWorkflow: string, actor: string, wafRef: string, held: string[], deployTokenLevels: string[], switches: Record<string, SwitchSpec>, rungs: Record<string, Rung>}} Table */
/** @typedef {{level: string, undo: boolean, meter?: string | undefined}} Options */
/** @typedef {{action: "disable" | "enable", workflow: string}} Freeze */
/** @typedef {{switch: string, value: string, from?: string}} PlanWrite */
/** @typedef {{id: string, op: string, params: Record<string, unknown>, permission: string, held: boolean}} PlanCall */
/** @typedef {{level: string, undo: boolean, title: string, summary: string, needsLockdownToken: boolean, freeze: Freeze, writes: PlanWrite[], calls: PlanCall[], manual: string[], permissions: {name: string, held: boolean}[]}} Plan */
/** @typedef {{status: number | null, stdout?: string, stderr?: string}} RunResult */
/** @typedef {{env: Record<string, string | undefined>, fetch: typeof fetch, run: (cmd: string, args: string[], env: Record<string, string>) => RunResult, now: () => number, sleep?: (ms: number) => Promise<void>, wrangler?: () => WranglerSettings}} Deps */
/** @typedef {{crons: string[], previews: boolean}} WranglerSettings */

const TABLE_URL = new URL("./lockdown-rungs.json", import.meta.url);
const WRANGLER_URL = new URL("../wrangler.jsonc", import.meta.url);
const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";
const SQL_TOKEN = /^[A-Za-z0-9_ =:.-]*$/;
const BATCH = 100;
const RETRIES_429 = 3;
const LOOKS = 5;
const LIVE_STATES = ["queued", "running", "paused", "waitingForPause", "waiting"];
const RUN_STATES = ["in_progress", "queued", "waiting", "requested"];
// A row this tool wrote at some level; the undo's own label ('lockdown:undo') deliberately does not match.
const OWNED = "updated_by GLOB 'lockdown:L[1-5]'";

/** @returns {Table} */
export const loadTable = () => JSON.parse(readFileSync(TABLE_URL, "utf8"));

/** The meter switches L1 accepts, in table order. @param {Table} table */
export const meterNames = (table) => Object.keys(table.rungs.L1?.meters ?? {});

/** The Worker variable that holds a switch at a value when D1 is unreachable (docs/spend.md owns the rule). @param {string} name */
const floorVar = (name) => `SWITCH_${name.toUpperCase()}`;

/** Removes `//` and block comments from JSONC, leaving string contents (URLs hold `//`) alone. @param {string} text */
function stripJsonComments(text) {
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

/** What a deploy of this checkout would set, so an undo puts back exactly that. @returns {WranglerSettings} */
export function wranglerSettings() {
  const cfg = JSON.parse(stripJsonComments(readFileSync(WRANGLER_URL, "utf8")));
  return { crons: cfg.triggers?.crons ?? [], previews: cfg.preview_urls === true };
}

/**
 * The token a rung runs with: the lockdown token, or the deploy token for the rungs the table lets fall back.
 * @param {Table} table
 * @param {string} level
 * @param {Deps["env"]} env
 */
export function tokenFor(table, level, env) {
  if (env.LOCKDOWN_CF_TOKEN) return env.LOCKDOWN_CF_TOKEN;
  return table.deployTokenLevels.includes(level) ? env.CLOUDFLARE_API_TOKEN : undefined;
}

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
  if (undo && writes.length) {
    manual.push(
      `Remove any ${writes.map((w) => floorVar(w.switch)).join(", ")} Worker variable you set by hand (dashboard and wrangler.jsonc): a row never loosens a floor.`,
    );
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
    needsLockdownToken: !table.deployTokenLevels.includes(level),
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
 * Two statements per write, the log line first so it can record what the row held before.
 * - A set never loosens: it replaces a row only with a strictly stricter value (an unknown stored value counts as the
 *   strictest), labels it `lockdown:L<n>`, and logs `prior=` the value from before any lockdown touched the row.
 * - An undo touches only rows labeled at or below its level, restores the logged prior (the default when none was
 *   logged), and labels the row `lockdown:undo`, so a second undo finds nothing and a later set reads it as the owner's.
 * The log has the write's own predicate, so a run that changes nothing logs nothing.
 * @param {Table} table
 * @param {PlanWrite} write
 * @param {{level: string, undo: boolean, now: number}} ctx
 * @returns {string[]}
 */
export function writeSql(table, write, { level, undo, now }) {
  const spec = assertAllowed(table, write.switch, write.value);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("now must be a positive integer (epoch ms)");
  const rungNumber = /^L([1-5])$/.exec(level)?.[1];
  if (!rungNumber) throw new Error("bad level");
  const key = lit(write.switch);
  const value = lit(write.value);
  const fallback = lit(spec.default);
  const actor = lit(table.actor);
  /** @param {string} column */
  const rank = (column) =>
    `CASE ${column} ${spec.values.map((v, i) => `WHEN ${lit(v)} THEN ${i}`).join(" ")} ELSE ${spec.values.length} END`;
  const lastPrior = `(SELECT substr(reason, instr(reason, 'prior=') + 6) FROM admin_action WHERE action = 'lockdown.set' AND target_id = ${key} ORDER BY id DESC LIMIT 1)`;
  const insertLog = `INSERT INTO admin_action (at, admin_user_id, action, target_kind, target_id, reason) SELECT ${now}, ${actor},`;

  if (undo) {
    const owned = `updated_by IN (${Array.from({ length: Number(rungNumber) }, (_, i) => lit(`${table.actor}:L${i + 1}`)).join(", ")})`;
    const prior = `COALESCE(${lastPrior}, ${fallback})`;
    return [
      `${insertLog} 'lockdown.undo', 'setting', ${key}, ${lit(`${table.actor} L${rungNumber} undo ${write.switch} prior=`)} || ${prior} WHERE EXISTS (SELECT 1 FROM setting WHERE key = ${key} AND ${owned});`,
      `UPDATE setting SET value = ${prior}, updated_at = ${now}, updated_by = ${lit(`${table.actor}:undo`)} WHERE key = ${key} AND ${owned};`,
    ];
  }
  const owner = lit(`${table.actor}:L${rungNumber}`);
  const prior = `CASE WHEN EXISTS (SELECT 1 FROM setting WHERE key = ${key} AND ${OWNED}) THEN COALESCE(${lastPrior}, ${fallback}) ELSE COALESCE((SELECT value FROM setting WHERE key = ${key}), ${fallback}) END`;
  const lower = Array.from({ length: Number(rungNumber) - 1 }, (_, i) => lit(`${table.actor}:L${i + 1}`));
  // Escalating over an equal value only relabels the row, so an undo of the lower level no longer reaches it.
  const relabel = lower.length
    ? `UPDATE setting SET updated_by = ${owner} WHERE key = ${key} AND value = ${value} AND updated_by IN (${lower.join(", ")});`
    : undefined;
  return [
    `${insertLog} 'lockdown.set', 'setting', ${key}, ${lit(`${table.actor} L${rungNumber} set ${write.switch}=${write.value} prior=`)} || ${prior} WHERE NOT EXISTS (SELECT 1 FROM setting WHERE key = ${key} AND ${rank("value")} >= ${rank(value)});`,
    `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (${key}, ${value}, ${now}, ${owner}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by WHERE ${rank("setting.value")} < ${rank("excluded.value")};`,
    ...(relabel ? [relabel] : []),
  ];
}

/**
 * The wrangler argv for the whole write batch, one call. Only `d1 execute`, never a deploy: a forced Durable Object
 * code update (`--durable-objects-code-update-mode immediate`) drops live sockets and resets a running conversion.
 * @param {Table} table @param {string[]} statements
 */
const wranglerArgs = (table, statements) => [
  "wrangler",
  "d1",
  "execute",
  table.database,
  "--remote",
  "--json",
  "--command",
  statements.join("\n"),
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
  const repo = "^\\/repos\\/[^/]+\\/[^/]+\\/actions\\/";
  if (m === "PUT" && new RegExp(`${repo}workflows\\/[\\w.-]+\\/(enable|disable)$`).test(clean)) return;
  if (m === "POST" && new RegExp(`${repo}runs\\/\\d+\\/cancel$`).test(clean)) return;
  if (clean.startsWith("/repos/")) throw new Error(`refused: ${m} ${clean}`);
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
  const instances = `${acct}/workflows/${table.workflow}/instances`;
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
        {
          method: "POST",
          path: `${script}/subdomain`,
          note: params.enabled
            ? "workers.dev on, previews as wrangler.jsonc has them"
            : "workers.dev off, previews off",
        },
      ];
    case "clearSchedules":
      return [
        { method: "GET", path: `${script}/schedules`, note: "read the cron triggers" },
        { method: "PUT", path: `${script}/schedules`, note: "set no cron triggers" },
      ];
    case "restoreSchedules":
      return [
        { method: "GET", path: `${script}/schedules`, note: "read the cron triggers" },
        { method: "PUT", path: `${script}/schedules`, note: "set the crons wrangler.jsonc lists" },
      ];
    case "terminateWorkflows":
      return [
        { method: "GET", path: `${instances}?status={state}&per_page=100`, note: "list live instances, every page" },
        { method: "POST", path: `${instances}/batch/terminate`, note: "terminate up to 100 ids at a time" },
        {
          method: "PATCH",
          path: `${instances}/{id}/status`,
          note: "fallback only if the batch call answers 404 or 405",
        },
        {
          method: "GET",
          path: `${instances}?status={state}&per_page=100`,
          note: "list again; any left fails the step",
        },
      ];
    default:
      throw new Error(`unknown op ${op}`);
  }
}

/** @param {Plan} plan */
const freezeLines = (plan) => {
  const { action, workflow } = plan.freeze;
  const repo = "/repos/{repo}/actions";
  return [
    `GET ${repo}/workflows/${workflow}`,
    `PUT ${repo}/workflows/${workflow}/${action}`,
    ...(action === "disable"
      ? [
          `GET ${repo}/workflows/${workflow}/runs?status={state}`,
          `POST ${repo}/runs/{id}/cancel  cancel what is running or queued`,
        ]
      : [`(L1 to L3 undo only unfreezes after reading the WAF rule and workers.dev: GET the rule and the subdomain)`]),
  ];
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
  out.push("", `1. ${plan.freeze.action === "disable" ? "Freeze" : "Unfreeze"} deploys`);
  for (const l of freezeLines(plan)) out.push(`   ${l}`);
  out.push("", "2. D1 setting rows (one npx wrangler d1 execute, remote)");
  if (plan.writes.length === 0) out.push("   none");
  const now = 1234567890123;
  for (const w of plan.writes) {
    out.push(`   ${w.switch} -> ${w.from ? `its prior value (default ${w.value})` : w.value}`);
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
    out.push(
      `   ${c.id} (needs ${c.permission}${c.held ? ", held by the deploy token" : ", NOT held by the deploy token"})`,
    );
    for (const r of describeRequests(table, c)) out.push(`     ${r.method} ${r.path}  ${r.note}`);
  }
  out.push("", "4. By hand");
  if (plan.manual.length === 0) out.push("   none");
  for (const m of plan.manual) out.push(`   - ${m}`);
  out.push(
    "",
    `Token: ${plan.needsLockdownToken ? "LOCKDOWN_CF_TOKEN" : "LOCKDOWN_CF_TOKEN, or the deploy token (CLOUDFLARE_API_TOKEN) as a fallback"}`,
    `Token permissions: ${plan.permissions.map((p) => `${p.name}${p.held ? "" : " (extra)"}`).join("; ") || "none"}`,
  );
  return out.join("\n");
}

class ApiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.status = status ?? 0;
  }
}

/** @param {unknown} e */
const statusOf = (e) => (e instanceof ApiError ? e.status : 0);

/**
 * A request function over fetch. A 429 waits for Retry-After (at most 30 s) and tries again, three times.
 * @param {Deps} deps
 * @param {string} base
 * @param {Record<string, string>} headers
 */
function client(deps, base, headers) {
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {number[]} [accept] extra statuses that are an answer, not an error
   * @returns {Promise<{status: number, json: any, result: any}>}
   */
  return async (method, path, body, accept = []) => {
    assertSafeCall(method, path);
    for (let attempt = 0; ; attempt += 1) {
      const res = await deps.fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (res.status === 429 && attempt < RETRIES_429) {
        await sleep(Math.min(Number(res.headers.get("retry-after")) || 2, 30) * 1000);
        continue;
      }
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
        throw new ApiError(
          `${method} ${path.split("?")[0]} answered ${res.status}${codes ? ` (${codes})` : ""}`,
          res.status,
        );
      }
      return { status: res.status, json, result: json.result };
    }
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

/** The zone, its custom-rules ruleset (if any) and our rule (if any). @param {Api} cf @param {Table} table @param {string} account */
async function findRule(cf, table, account) {
  const zones = await cf(
    "GET",
    `/zones?name=${encodeURIComponent(table.zone)}&account.id=${encodeURIComponent(account)}`,
  );
  const zone = zones.result?.[0]?.id;
  if (!zone) throw new ApiError(`zone ${table.zone} not found for this token`, 404);
  const phase = `/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const entry = await cf("GET", phase, undefined, [404]);
  const ruleset = entry.status === 404 ? undefined : entry.result;
  const rule = (ruleset?.rules ?? []).find((/** @type {any} */ r) => r.ref === table.wafRef);
  return { zone, phase, ruleset, rule };
}

/** @param {Table} table @param {string} account */
const scriptPath = (table, account) => `/accounts/${account}/workers/scripts/${table.worker}`;

/**
 * Every live instance of the workflow, every page, deduped.
 * @param {Api} cf
 * @param {string} base
 * @returns {Promise<string[] | undefined>} undefined when the workflow does not exist
 */
async function liveInstances(cf, base) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const state of LIVE_STATES) {
    let cursor = "";
    for (let page = 0; page < 1000; page += 1) {
      const list = await cf(
        "GET",
        `${base}?status=${state}&per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        undefined,
        [404],
      );
      if (list.status === 404) return undefined;
      for (const inst of list.result ?? []) ids.add(String(inst.id));
      cursor = list.json?.result_info?.cursor ?? "";
      if (!cursor || (list.result ?? []).length === 0) break;
    }
  }
  return [...ids];
}

/**
 * Each op reads first and writes only on a difference, so a second run changes nothing.
 * @type {Record<string, (cf: Api, table: Table, account: string, params: Record<string, unknown>, ctx: {settings: WranglerSettings, sleep: (ms: number) => Promise<void>}) => Promise<string>>}
 */
const OPS = {
  async wafRule(cf, table, account, params) {
    const want = params.enabled === true;
    const { zone, phase, ruleset, rule } = await findRule(cf, table, account);
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

  async workersDev(cf, table, account, params, ctx) {
    const want = params.enabled === true;
    // Lockdown turns previews off with workers.dev; an undo puts back what a deploy of this checkout would set.
    const previews = want ? ctx.settings.previews : false;
    const path = `${scriptPath(table, account)}/subdomain`;
    const now = (await cf("GET", path)).result;
    if ((now?.enabled === true) === want && (now?.previews_enabled === true) === previews) {
      return `unchanged: workers.dev already ${want ? "on" : "off"}`;
    }
    await cf("POST", path, { enabled: want, previews_enabled: previews });
    return `changed: workers.dev ${want ? "on" : "off"}, previews ${previews ? "on" : "off"}`;
  },

  async clearSchedules(cf, table, account) {
    const path = `${scriptPath(table, account)}/schedules`;
    const crons = (await cf("GET", path)).result?.schedules ?? [];
    if (crons.length === 0) return "unchanged: no cron triggers";
    await cf("PUT", path, []);
    return `changed: ${crons.length} cron trigger(s) cleared`;
  },

  async restoreSchedules(cf, table, account, _params, ctx) {
    const path = `${scriptPath(table, account)}/schedules`;
    const want = [...ctx.settings.crons].sort();
    const have = ((await cf("GET", path)).result?.schedules ?? []).map((/** @type {any} */ s) => s.cron).sort();
    if (JSON.stringify(want) === JSON.stringify(have))
      return "unchanged: cron triggers already as wrangler.jsonc lists";
    await cf(
      "PUT",
      path,
      ctx.settings.crons.map((cron) => ({ cron })),
    );
    return `changed: ${want.length} cron trigger(s) restored`;
  },

  async terminateWorkflows(cf, table, account, _params, ctx) {
    const base = `/accounts/${account}/workflows/${table.workflow}/instances`;
    const ids = await liveInstances(cf, base);
    if (!ids) return "unchanged: no such workflow";
    let failures = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      try {
        await cf("POST", `${base}/batch/terminate`, chunk);
      } catch (e) {
        // Only an endpoint that is not there falls back; anything else (403, 5xx) is a real failure to report.
        if (![404, 405].includes(statusOf(e))) throw e;
        for (const id of chunk) {
          try {
            await cf("PATCH", `${base}/${encodeURIComponent(id)}/status`, { status: "terminate" });
          } catch {
            failures += 1;
          }
        }
      }
    }
    if (ids.length === 0) return "unchanged: no live instances";
    let left = ids;
    for (let attempt = 0; attempt < LOOKS; attempt += 1) {
      left = (await liveInstances(cf, base)) ?? [];
      if (left.length === 0) break;
      if (attempt < LOOKS - 1) await ctx.sleep(1000 * 2 ** attempt);
    }
    if (left.length > 0 || failures > 0) {
      throw new ApiError(
        `${left.length} instance(s) still live after terminate, ${failures} single terminate(s) failed`,
      );
    }
    return `changed: ${ids.length} instance(s) terminated`;
  },
};

/** A GitHub client scoped to the repository's Actions API. @param {Deps} deps @param {string} repo @param {string} token */
function githubClient(deps, repo, token) {
  const gh = client(deps, GH, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  return { gh, base: `/repos/${repo}/actions` };
}

/** Every secret value in the environment, replaced in anything printed. @param {Deps["env"]} env @param {string} text */
const redact = (env, text) =>
  ["LOCKDOWN_CF_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GITHUB_TOKEN"].reduce((t, k) => {
    const v = env[k];
    return v && v.length >= 6 ? t.split(v).join("***") : t;
  }, text);

/**
 * Runs every write in one wrangler call and returns the rows each statement changed (null when the output is not
 * the JSON array wrangler prints: one entry per statement, each with `meta.changes`).
 * @param {Table} table
 * @param {Deps} deps
 * @param {string[]} statements
 * @param {Record<string, string>} env
 * @returns {number[] | null}
 */
function runD1(table, deps, statements, env) {
  const res = deps.run("npx", wranglerArgs(table, statements), env);
  if (res.status !== 0) {
    const why = (res.stderr || res.stdout || "").trim().split("\n").find(Boolean) ?? "no output";
    throw new Error(`wrangler exited ${res.status}: ${why.slice(0, 300)}`);
  }
  try {
    const out = res.stdout ?? "";
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    return Array.isArray(parsed) ? parsed.map((r) => Number(r?.meta?.changes ?? 0)) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the L4 edge block is still in force: the WAF rule on, or workers.dev off. Throws when it cannot be read.
 * @param {Api} cf
 * @param {Table} table
 * @param {string} account
 */
async function edgeInForce(cf, table, account) {
  /** @type {string[]} */
  const reasons = [];
  const { rule } = await findRule(cf, table, account);
  if (rule?.enabled) reasons.push("the WAF block rule is on");
  const sub = (await cf("GET", `${scriptPath(table, account)}/subdomain`)).result;
  if (sub?.enabled === false) reasons.push("workers.dev is off");
  return reasons;
}

/**
 * Applies the plan: freeze, D1 rows, Cloudflare calls, then the by-hand list (an undo runs in the reverse order, so
 * deploys come back last). A failed step is reported and the rest still run; a failed D1 write prints the var floors.
 * `warned` means deploys are not frozen after a set: the caller must make that loud.
 * @param {Table} table
 * @param {Plan} plan
 * @param {Deps} deps
 * @returns {Promise<{lines: string[], failed: boolean, warned: boolean, stillFrozen: boolean}>}
 */
export async function execute(table, plan, deps) {
  const env = deps.env;
  const token = tokenFor(table, plan.level, env);
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const missing = [
    ...(token
      ? []
      : [
          plan.needsLockdownToken
            ? "LOCKDOWN_CF_TOKEN (this rung does not use the deploy token)"
            : "LOCKDOWN_CF_TOKEN or CLOUDFLARE_API_TOKEN",
        ]),
    ...(account ? [] : ["CLOUDFLARE_ACCOUNT_ID"]),
  ];
  if (missing.length) throw new Error(`set ${missing.join(" and ")} in the environment`);
  const block = await spendBlockCheck(table, deps);
  const cf = client(deps, CF, { Authorization: `Bearer ${token}` });
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ctx = { settings: (deps.wrangler ?? wranglerSettings)(), sleep };
  const now = deps.now();
  /** @type {string[]} */
  const lines = [`${plan.level} ${plan.undo ? "UNDO" : "lockdown"}: ${plan.summary}`];
  let failed = false;
  let warned = false;
  let stillFrozen = false;
  /** @param {string} label @param {() => Promise<string> | string} run @returns {Promise<boolean>} */
  const step = async (label, run) => {
    try {
      lines.push(`${label}: ${await run()}`);
      return true;
    } catch (e) {
      failed = true;
      lines.push(`${label}: FAILED ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const freeze = async () => {
    const label = `${plan.freeze.action} deploys (${plan.freeze.workflow})`;
    const hand = `by hand, Actions, ${plan.freeze.workflow}, the ... menu, ${plan.freeze.action === "disable" ? "Disable" : "Enable"} workflow`;
    const repo = env.GITHUB_REPOSITORY;
    const ghToken = env.GITHUB_TOKEN;
    if (!repo || !ghToken) {
      lines.push(`${label}: not done here (no GITHUB_TOKEN or GITHUB_REPOSITORY): ${hand}`);
      warned = !plan.undo;
      stillFrozen = plan.undo;
      return;
    }
    const { gh, base } = githubClient(deps, repo, ghToken);
    const path = `${base}/workflows/${plan.freeze.workflow}`;
    if (plan.undo && !plan.calls.some((c) => c.op === "wafRule")) {
      // An L1 to L3 undo must not re-enable deploys while L4 or L5 is still in force: a deploy turns workers.dev back on.
      try {
        const reasons = await edgeInForce(cf, table, account ?? "");
        if (reasons.length) {
          lines.push(`${label}: skipped, ${reasons.join(" and ")}; undo L4 first, then enable deploys`);
          return;
        }
      } catch (e) {
        lines.push(
          `${label}: skipped, could not read the L4 state (${e instanceof Error ? e.message : String(e)}); ${hand}`,
        );
        stillFrozen = true;
        return;
      }
    }
    const ok = await step(label, async () => {
      const active = (await gh("GET", path)).json?.state === "active";
      /** @type {string[]} */
      const did = [];
      if (active !== (plan.freeze.action === "enable")) {
        await gh("PUT", `${path}/${plan.freeze.action}`);
        did.push(`workflow ${plan.freeze.action}d`);
      }
      if (plan.freeze.action === "disable") {
        let cancelled = 0;
        for (const state of RUN_STATES) {
          const runs = (await gh("GET", `${path}/runs?status=${state}&per_page=100`)).json?.workflow_runs ?? [];
          for (const r of runs) {
            await gh("POST", `${base}/runs/${Number(r.id)}/cancel`, undefined, [409]);
            cancelled += 1;
          }
        }
        if (cancelled) did.push(`${cancelled} run(s) cancelled`);
      }
      return did.length ? `changed: ${did.join(", ")}` : `unchanged: already ${plan.freeze.action}d`;
    });
    if (!ok) {
      warned = !plan.undo;
      stillFrozen = plan.undo;
    }
  };

  const rows = async () => {
    const perWrite = plan.writes.map((w) => writeSql(table, w, { level: plan.level, undo: plan.undo, now }));
    const statements = perWrite.flat();
    if (statements.length === 0) return;
    /** @type {number[] | null} */
    let counts = null;
    const ok = await step("D1 write", () => {
      counts = runD1(table, deps, statements, {
        CLOUDFLARE_API_TOKEN: token ?? "",
        CLOUDFLARE_ACCOUNT_ID: account ?? "",
      });
      return `${plan.writes.length} row(s) sent in one call`;
    });
    if (!ok) {
      const floors = floorsOf(plan);
      if (floors.length) {
        lines.push("D1 failed: set these Worker variables by hand, then commit them to wrangler.jsonc:");
        for (const f of floors) lines.push(`  ${f.name}=${f.value}`);
      }
      return;
    }
    plan.writes.forEach((w, i) => {
      const offset = perWrite.slice(0, i).reduce((n, s) => n + s.length, 0);
      const seen = /** @type {number[] | null} */ (counts);
      const changed = seen?.[offset + 1];
      // Only a set at L2 or above has a third (relabel) statement; reading past a write's own would be its neighbor's.
      const relabeled = (perWrite[i]?.length ?? 0) > 2 ? (seen?.[offset + 2] ?? 0) : 0;
      const verdict =
        changed === undefined
          ? "ran (change count unavailable)"
          : changed > 0
            ? "changed"
            : relabeled > 0
              ? "relabeled"
              : "unchanged";
      lines.push(`D1 ${w.switch} ${plan.undo ? "restored to its prior value" : `-> ${w.value}`}: ${verdict}`);
    });
  };

  const api = async () => {
    for (const c of plan.calls) {
      const op = OPS[c.op];
      await step(c.id, () =>
        op ? op(cf, table, account ?? "", c.params, ctx) : Promise.reject(new Error(`unknown op ${c.op}`)),
      );
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
  if (warned) {
    lines.unshift(
      "DEPLOYS NOT FROZEN: a push to main redeploys and can undo this lockdown. Disable the deploy workflow by hand now (Actions, deploy, the ... menu, Disable workflow).",
    );
  }
  if (stillFrozen) {
    lines.unshift(
      "DEPLOYS STILL FROZEN: this undo could not enable the deploy workflow. Enable it by hand (Actions, deploy, the ... menu, Enable workflow) once L4 is off.",
    );
  }
  // The spend-block answer is the first line, above any DEPLOYS headline.
  return { lines: [block, ...lines].map((l) => redact(env, l)), failed, warned, stillFrozen };
}

/**
 * What the dry run can say about the token with reads only: that it is active, and for each rung step whether the
 * first read it makes is allowed. A read cannot prove a write permission, so only a refusal is reported.
 * @param {Table} table
 * @param {Plan} plan
 * @param {Deps} deps
 * @returns {Promise<string[]>}
 */
export async function tokenReport(table, plan, deps) {
  const env = deps.env;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = tokenFor(table, plan.level, env);
  if (plan.needsLockdownToken && !env.LOCKDOWN_CF_TOKEN) {
    return [`${plan.level} WILL FAIL: LOCKDOWN_CF_TOKEN is not set (this rung does not use the deploy token)`];
  }
  if (!token || !account) return ["token: not checked (CLOUDFLARE_ACCOUNT_ID and a token are not in the environment)"];
  const cf = client(deps, CF, { Authorization: `Bearer ${token}` });
  /** @type {string[]} */
  const out = [];
  const verified = await cf("GET", `/accounts/${encodeURIComponent(account)}/tokens/verify`).catch(() =>
    cf("GET", "/user/tokens/verify").catch(() => null),
  );
  if (verified?.result?.status !== "active") {
    return [`${plan.level} WILL FAIL: the token did not verify as active`];
  }
  out.push("token: active");
  /** @type {string[]} */
  const lacks = [];
  /** @param {string} permission @param {string} path @param {number[]} [accept] */
  const probe = async (permission, path, accept = []) => {
    try {
      return await cf("GET", path, undefined, accept);
    } catch (e) {
      if ([401, 403].includes(statusOf(e)))
        lacks.push(`token lacks ${permission} (${e instanceof Error ? e.message : "refused"})`);
      return undefined;
    }
  };
  if (plan.writes.length) await probe("D1 Edit", `/accounts/${account}/d1/database?per_page=1`);
  for (const op of new Set(plan.calls.map((c) => c.op))) {
    if (op === "wafRule") {
      const zones = await probe(
        "Zone Read",
        `/zones?name=${encodeURIComponent(table.zone)}&account.id=${encodeURIComponent(account)}`,
      );
      const zone = zones?.result?.[0]?.id;
      if (zone)
        await probe("Zone WAF Edit", `/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`, [404]);
    } else if (op === "terminateWorkflows") {
      await probe(
        "Workers Scripts Write",
        `/accounts/${account}/workflows/${table.workflow}/instances?status=running&per_page=1`,
        [404],
      );
    } else {
      await probe(
        "Workers Scripts Write",
        `${scriptPath(table, account)}/${op.endsWith("Schedules") ? "schedules" : "subdomain"}`,
      );
    }
  }
  if (plan.writes.length) {
    // Proves the toolchain the writes depend on (npx, wrangler with no install scripts, D1 reachable) without writing.
    const res = deps.run("npx", wranglerArgs(table, ["SELECT 1;"]), {
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
    });
    if (res.status === 0) out.push("wrangler: d1 execute reached the database (read-only SELECT 1)");
    else {
      const why = (res.stderr || res.stdout || "").trim().split("\n").find(Boolean) ?? "no output";
      lacks.push(`wrangler d1 execute failed (${why.slice(0, 200)})`);
    }
  }
  out.push(
    lacks.length
      ? `${plan.level} WILL FAIL: ${[...new Set(lacks)].join("; ")}`
      : `${plan.level}: the reads this rung starts with are allowed (a write permission is proven only by running it)`,
  );
  return out;
}

const USAGE = `usage: node tools/lockdown.mjs --level L1..L5 [--meter <switch>] [--undo] [--apply]
  Dry run unless --apply. L1 needs --meter. Needs CLOUDFLARE_ACCOUNT_ID and LOCKDOWN_CF_TOKEN
  (L1 and L2 may use CLOUDFLARE_API_TOKEN instead). The dry run reads the token's state if they are set.
  GITHUB_TOKEN and GITHUB_REPOSITORY (set in Actions) let it freeze deploys; without them it prints the step (exit 3).`;

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
 * The ladder's first check, before any rung: does the site answer? A Workers or Durable Objects spend block rejects
 * every invocation, crons included, so the breaker and the spend guard are down and Cloudflare's own spend alert mails
 * are the only signal. This tool's API calls are not Worker invocations, so the ladder still runs; the line says what
 * the block means for it. An L4 or L5 already in force answers the same way.
 * @param {Table} table
 * @param {Deps} deps
 * @returns {Promise<string>}
 */
export async function spendBlockCheck(table, deps) {
  const url = `https://${table.zone}/api/health`;
  let why;
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(10_000) });
    /** @type {any} */
    const body = await res.json().catch(() => null);
    if (res.ok && body?.status === "ok") return `spend block: none seen (${url} answers)`;
    why = `answered ${res.status}`;
  } catch {
    why = "did not answer";
  }
  return [
    `SPEND BLOCK ACTIVE? ${url} ${why}: a Workers or Durable Objects spend block, an L4 or L5 in force, or an outage.`,
    "During a spend block every invocation is rejected, crons included, so the breaker and the spend guard are down and Cloudflare's spend-limit alert mails ($2, $5) are the only signal. Raise or clear the limit in the dashboard (Billing, Spend limits); the rungs below still run, since they are API calls.",
  ].join("\n");
}

/**
 * Exit codes: 0 done, 1 a step failed, 2 bad input or missing credentials, 3 done but deploys are not frozen.
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
    if (!cli.apply) {
      const block = await spendBlockCheck(table, deps);
      const report = await tokenReport(table, plan, deps);
      return {
        code: 0,
        out: `${block}\n\n${renderPlan(table, plan, false)}\n\n${redact(deps.env, report.join("\n"))}`,
      };
    }
    const { lines, failed, warned, stillFrozen } = await execute(table, plan, deps);
    return { code: failed ? 1 : warned || stillFrozen ? 3 : 0, out: lines.join("\n") };
  } catch (e) {
    return { code: 2, out: `lockdown: ${redact(deps.env, e instanceof Error ? e.message : String(e))}\n${USAGE}` };
  }
}

// realpath on both sides: a symlinked path to this file must still run the CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { code, out } = await main(process.argv.slice(2), {
    env: process.env,
    fetch,
    run: (cmd, args, env) =>
      spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 }),
    now: Date.now,
  });
  console.log(out);
  process.exitCode = code;
}
