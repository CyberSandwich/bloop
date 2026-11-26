// Checks a deployed origin against the repo: every page and its headers, the gated pages' 404s, encoded forms of the
// gated paths, the lazy modules and the file origin's probe. Run after every land. Usage:
//   node tools/live-check.mjs <origin> [--mode preview|open]
// Paths go out exactly as written (node:https): fetch would resolve `/%2e/` and `/./` before sending. In the sandbox
// Node needs NODE_USE_ENV_PROXY=1.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DYNAMIC_PAGES, pageCsp } from "../src/worker/headers.ts";
import { AUTH_SHELLS, MEMBER_PAGES, VARIANTS } from "../src/worker/page-registry.ts";
import { entriesFrom } from "./size-ratchet.mjs";
import { staticHeaders } from "./static-headers.mjs";
import { wranglerConfig } from "./wrangler-config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const NOINDEX_META = '<meta name="robots" content="noindex">';
const FOREIGN = "https://foreign.invalid";
const MAX_HOPS = 5;

/**
 * @typedef {{ path: string, noindex: boolean }} Page
 * @typedef {{ pages: Page[], shells: { path: string, exists: boolean }[], members: string[], gated: string[],
 *   lazy: string[], headersFile: string, fileOrigin: string | null, uploadMode: string }} Registry
 * @typedef {{ status?: number, header?: Record<string, string>, headerNot?: Record<string, string>,
 *   headerAbsent?: string[], body?: string, bodyNot?: string, contentType?: string }} Expect
 * @typedef {{ what: string, url: string, headers?: Record<string, string>, follow?: boolean, expect: Expect }} Check
 * @typedef {{ status: number, headers: Record<string, string>, body: string }} Observed
 * @typedef {(url: string, headers: Record<string, string>) => Promise<Observed>} Get
 */

/** What the live site must answer, read from the page registry (page-registry.ts), public/, the size budgets and wrangler. */
export function registryFrom(root = ROOT) {
  const pub = join(root, "public");
  const hidden = new Set([...AUTH_SHELLS, ...MEMBER_PAGES, ...VARIANTS.map((v) => v.path)]);
  const pages = readdirSync(pub)
    .filter((f) => f.endsWith(".html") && f !== "404.html")
    .map((f) => ({
      path: f === "index.html" ? "/" : `/${f.slice(0, -".html".length)}`,
      noindex: readFileSync(join(pub, f), "utf8").includes(NOINDEX_META),
    }))
    .filter((p) => !hidden.has(p.path));
  const tree = {
    show: (/** @type {string} */ f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null),
    list: (/** @type {string} */ d) =>
      existsSync(join(root, d)) ? readdirSync(join(root, d)).map((f) => `${d}/${f}`) : [],
  };
  const lazy = entriesFrom(tree)
    .filter((e) => e.name.endsWith(", lazy"))
    .flatMap((e) => [e.path].flat().map(String))
    .filter((p) => p.startsWith("dist/") && p.endsWith(".js") && !/[*?[{]/.test(p))
    .map((p) => p.slice("dist".length));
  const vars = wranglerConfig(readFileSync(join(root, "wrangler.jsonc"), "utf8")).vars ?? {};
  return {
    pages,
    shells: [...AUTH_SHELLS].map((path) => ({ path, exists: existsSync(join(pub, `${path.slice(1)}.html`)) })),
    members: [...MEMBER_PAGES],
    gated: [...MEMBER_PAGES, "/open"],
    lazy: [...new Set(lazy)],
    headersFile: readFileSync(join(pub, "_headers"), "utf8"),
    fileOrigin: vars.FILE_ORIGIN || null,
    uploadMode: vars.UPLOAD_MODE ?? "proxy",
  };
}

/** The request forms a gated path must refuse: encoded letters, dot and slash tricks, the file form, another case. */
export function probeForms(/** @type {string} */ path) {
  const name = path.slice(1);
  const hex = name.charCodeAt(0).toString(16);
  const rest = name.slice(1);
  return [
    ...new Set([
      path,
      `/%${hex}${rest}`,
      `/%${hex.toUpperCase()}${rest}`,
      `/%${hex}${rest}/`,
      `/%2e${path}`,
      `/${path}`,
      `${path}/./privacy`,
      `/%2F${name}`,
      `${path}.html`,
      `/${name.charAt(0).toUpperCase()}${rest}`,
    ]),
  ];
}

/** The headers a page answers with: _headers for the path, the CSP completed at serve time for a dynamic page. */
function pageHeaders(/** @type {Registry} */ reg, /** @type {string} */ path) {
  const out = staticHeaders(reg.headersFile, path);
  const spec = DYNAMIC_PAGES[path];
  // In direct upload mode the R2 endpoint holds the account id, a secret the repo does not have: CSP is not compared.
  if (spec?.r2 && reg.uploadMode === "direct") delete out["content-security-policy"];
  else if (spec)
    out["content-security-policy"] = /** @type {string} */ (
      pageCsp(path, { fileOrigin: reg.fileOrigin, r2Endpoint: null })
    );
  return out;
}

/**
 * @param {Registry} reg @param {{ origin: string, mode: "preview" | "open" }} at
 * @returns {Check[]}
 */
export function checksFor(reg, { origin, mode }) {
  /** @type {Check[]} */
  const checks = reg.pages.map((p) => ({
    what: `page ${p.path}`,
    url: `${origin}${p.path}`,
    expect: {
      status: 200,
      header: pageHeaders(reg, p.path),
      headerAbsent: ["x-robots-tag"],
      ...(p.noindex ? { body: NOINDEX_META } : { bodyNot: NOINDEX_META }),
    },
  }));
  for (const s of reg.shells) {
    const shown = s.exists ? { status: 200, header: pageHeaders(reg, s.path) } : { status: 404 };
    checks.push({
      what: `sign-in page ${s.path} (${mode})`,
      url: `${origin}${s.path}`,
      expect:
        mode === "preview"
          ? { ...shown, header: { ...shown.header, "x-robots-tag": "noindex" } }
          : { ...shown, headerAbsent: ["x-robots-tag"] },
    });
  }
  for (const m of reg.members) {
    checks.push({
      what: `member page ${m} signed out`,
      url: `${origin}${m}`,
      expect: { status: 404, body: NOINDEX_META },
    });
  }
  for (const g of reg.gated) {
    for (const form of probeForms(g)) {
      checks.push({
        what: `gated ${g} as ${form}`,
        url: `${origin}${form}`,
        follow: true,
        expect: { status: 404, body: NOINDEX_META },
      });
    }
  }
  for (const path of reg.lazy) {
    checks.push({
      what: `lazy ${path}`,
      url: `${origin}${path}`,
      expect: { status: 200, contentType: "text/javascript" },
    });
  }
  if (reg.fileOrigin) {
    const ping = `${reg.fileOrigin}/fo/ping`;
    checks.push(
      {
        what: "file origin /fo/ping from the site",
        url: ping,
        headers: { Origin: origin },
        expect: { status: 204, header: { "access-control-allow-origin": origin, "cache-control": "no-store" } },
      },
      {
        what: "file origin /fo/ping from a foreign origin",
        url: ping,
        headers: { Origin: FOREIGN },
        expect: { headerNot: { "access-control-allow-origin": FOREIGN } },
      },
      {
        what: "file origin / sends visitors to the site",
        url: `${reg.fileOrigin}/`,
        expect: { status: 301, header: { location: `${origin}/` } },
      },
      { what: "the site has no /fo/ping", url: `${origin}/fo/ping`, expect: { status: 404 } },
    );
  }
  return checks;
}

/** @param {Expect} e @param {Observed} o @returns {string[]} one line per miss */
export function missesFor(e, o) {
  const misses = [];
  const show = (/** @type {string | undefined} */ v) => JSON.stringify(v ?? null);
  if (e.status !== undefined && o.status !== e.status) misses.push(`status ${o.status}, want ${e.status}`);
  for (const [name, want] of Object.entries(e.header ?? {})) {
    if (o.headers[name] !== want) misses.push(`${name} ${show(o.headers[name])}, want ${show(want)}`);
  }
  for (const [name, bad] of Object.entries(e.headerNot ?? {})) {
    if (o.headers[name] === bad) misses.push(`${name} must not be ${show(bad)}`);
  }
  for (const name of e.headerAbsent ?? []) {
    if (name in o.headers) misses.push(`${name} ${show(o.headers[name])}, want none`);
  }
  if (e.body !== undefined && !o.body.includes(e.body)) misses.push(`body lacks ${e.body}`);
  if (e.bodyNot !== undefined && o.body.includes(e.bodyNot)) misses.push(`body has ${e.bodyNot}`);
  if (e.contentType !== undefined && !(o.headers["content-type"] ?? "").startsWith(e.contentType)) {
    misses.push(`content-type ${show(o.headers["content-type"])}, want ${e.contentType}`);
  }
  return misses;
}

/** A GET of `url` with its path sent byte for byte. @type {Get} */
export function rawGet(url, headers) {
  const at = url.indexOf("/", url.indexOf("://") + 3);
  const base = new URL(at < 0 ? url : url.slice(0, at));
  const send = base.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        path: at < 0 ? "/" : url.slice(at),
        headers: { Accept: "text/html,*/*", ...headers },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, [v].flat().join(", ")])),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Runs each check in order; a redirect is followed only where the check says so. @returns {Promise<string[]>} */
export async function run(/** @type {Check[]} */ checks, /** @type {Get} */ get = rawGet) {
  const misses = [];
  for (const c of checks) {
    let url = c.url;
    try {
      let o = await get(url, c.headers ?? {});
      for (let hop = 0; c.follow && hop < MAX_HOPS && o.status >= 300 && o.status < 400 && o.headers.location; hop++) {
        url = new URL(o.headers.location, url).href;
        o = await get(url, c.headers ?? {});
      }
      for (const m of missesFor(c.expect, o)) misses.push(`${c.what}: ${m}${url === c.url ? "" : ` (at ${url})`}`);
    } catch (e) {
      misses.push(`${c.what}: request failed: ${/** @type {Error} */ (e).message}`);
    }
  }
  return misses;
}

/** The CLI. @param {string[]} args @param {Get} [get] @returns {Promise<number>} the exit code */
export async function main(args, get = rawGet) {
  const at = args.indexOf("--mode");
  const mode = at < 0 ? "preview" : args[at + 1];
  const rest = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  const origin = rest[0] ?? "";
  if (rest.length !== 1 || !/^https?:\/\/[^/]+$/.test(origin) || (mode !== "preview" && mode !== "open")) {
    console.error("usage: node tools/live-check.mjs <origin, no path> [--mode preview|open]");
    return 64;
  }
  const checks = checksFor(registryFrom(), { origin, mode });
  const misses = await run(checks, get);
  for (const m of misses) console.error(`live-check: ${m}`);
  console.log(`live-check: ${checks.length} checks, ${misses.length} misses`);
  return misses.length > 0 ? 1 : 0;
}

// Real paths on both sides: run through a symlink (macOS /tmp is one) a plain compare is false and nothing runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  process.exit(await main(process.argv.slice(2)));
