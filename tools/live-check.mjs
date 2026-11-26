// Checks the deployed site against the repo and exits 1 on any miss. Run after every land. Usage:
//   node tools/live-check.mjs <PUBLIC_ORIGIN> [--mode preview|open]
// Paths go out exactly as written (node:https): fetch would resolve `/%2e/` and `/./` before sending. In the sandbox
// Node needs NODE_USE_ENV_PROXY=1.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sizeEntries from "../.size-limit.mjs";
import { DYNAMIC_PAGES, pageCsp } from "../src/worker/headers.ts";
import { AUTH_SHELLS, MEMBER_PAGES, VARIANTS } from "../src/worker/page-registry.ts";
import { paths } from "./size-ratchet.mjs";
import { staticHeaders } from "./static-headers.mjs";
import { wranglerConfig } from "./wrangler-config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const NOINDEX_META = '<meta name="robots" content="noindex">';
const FOREIGN = "https://foreign.invalid";
const MAX_HOPS = 5;
const RETRY_MS = 1000;
/** An R2 EU endpoint in a CSP: its host holds the account id, which the repo does not have. */
const R2_HOST = /^https:\/\/[a-z0-9]+\.eu\.r2\.cloudflarestorage\.com$/;
const TYPES = { ".js": "text/javascript", ".css": "text/css" };

/**
 * @typedef {{ path: string, exists: boolean }} Gated
 * @typedef {{ path: string, kind: "both" | "open-only" | "preview-only", to?: string }} Variant
 * @typedef {{ pages: { path: string, noindex: boolean }[], shells: Gated[], members: Gated[], variants: Variant[],
 *   lazy: { path: string, type: string | null }[], typeFiles: string[], headersFile: string, publicOrigin: string,
 *   fileOrigin: string | null, uploadMode: string }} Registry
 * @typedef {{ status?: number, success?: boolean, header?: Record<string, string>, headerNot?: Record<string, string>,
 *   headerAbsent?: string[], cspIgnoringR2?: string, body?: string, bodyNot?: string, contentType?: string }} Expect
 * @typedef {{ what: string, url: string, headers?: Record<string, string>, follow?: boolean, links?: boolean,
 *   expect: Expect }} Check
 * @typedef {{ status: number, headers: Record<string, string>, body: string }} Observed
 * @typedef {(url: string, headers: Record<string, string>) => Promise<Observed>} Get
 */

/** `articles/x.html` is `/articles/x`, `index.html` is `/`, a folder's `index.html` is the folder. */
const pathOf = (/** @type {string} */ rel) => `/${rel.replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "")}`;

/** A size-limit glob as a regex over public/ paths; `{}` and `[]` are refused rather than misread. */
export function globRegex(/** @type {string} */ glob) {
  if (/[{}[\]]/.test(glob)) throw new Error(`live-check: cannot expand lazy entry ${glob}`);
  const body = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((t) =>
      t === "**/"
        ? "(?:.*/)?"
        : t === "**"
          ? ".*"
          : t === "*"
            ? "[^/]*"
            : t === "?"
              ? "[^/]"
              : t.replace(/[.+^$()|\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

/**
 * A lazy entry's dist/ path as the public/ files it names (dist/ is built from public/, ADR 0011). A glob that names
 * nothing throws: it would add no check and pass.
 * @param {string} p @param {string[]} files public/ paths @returns {string[]}
 */
export function expandLazy(p, files) {
  if (!p.startsWith("dist/")) throw new Error(`live-check: lazy entry ${p} is not under dist/`);
  const rel = p.slice("dist/".length);
  if (!/[*?{}[\]]/.test(rel)) return [rel];
  const re = globRegex(rel);
  const hits = files.filter((f) => re.test(f));
  if (hits.length === 0) throw new Error(`live-check: lazy entry ${p} matches no file`);
  return hits;
}

/** What the live site must answer: the page registry (page-registry.ts), public/, the size budgets and wrangler. */
export function registryFrom() {
  const pub = join(ROOT, "public");
  // Open variant files sit under public/open/ and are served only through a listed variant.
  const files = readdirSync(pub, { recursive: true, encoding: "utf8" })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !f.startsWith("open/") && f !== "open");
  const html = new Set(files.filter((f) => f.endsWith(".html") && f !== "404.html"));
  const gatedPaths = new Set([...AUTH_SHELLS, ...MEMBER_PAGES]);
  const has = (/** @type {string} */ path) =>
    html.has(`${path.slice(1)}.html`) || html.has(`${path.slice(1)}/index.html`);
  const lazy = sizeEntries
    .filter((/** @type {{ name: string }} */ e) => e.name.endsWith(", lazy"))
    .flatMap(paths)
    .flatMap((/** @type {string} */ p) => expandLazy(p, files));
  const vars = wranglerConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")).vars ?? {};
  return {
    pages: [...html]
      .map((rel) => ({ path: pathOf(rel), noindex: readFileSync(join(pub, rel), "utf8").includes(NOINDEX_META) }))
      .filter((p) => !gatedPaths.has(p.path))
      .sort((a, b) => a.path.localeCompare(b.path)),
    shells: AUTH_SHELLS.map((path) => ({ path, exists: has(path) })),
    members: MEMBER_PAGES.map((path) => ({ path, exists: has(path) })),
    variants: VARIANTS.map((v) => ({ ...v })),
    lazy: [...new Set(lazy)].map((rel) => ({
      path: `/${rel}`,
      type: TYPES[/** @type {keyof typeof TYPES} */ (rel.slice(rel.lastIndexOf(".")))] ?? null,
    })),
    // Type declarations are for the editor and the typecheck; public/.assetsignore keeps them unserved, and the build
    // copies them to dist/, so a lost .assetsignore serves them.
    typeFiles: files.filter((f) => f.endsWith(".d.ts")).map((f) => `/${f}`),
    headersFile: readFileSync(join(pub, "_headers"), "utf8"),
    publicOrigin: String(vars.PUBLIC_ORIGIN ?? ""),
    fileOrigin: vars.FILE_ORIGIN || null,
    uploadMode: vars.UPLOAD_MODE ?? "proxy",
  };
}

/**
 * The request forms a gated path must refuse: encoded letters (once and twice), dot segments that resolve onto it,
 * slash and backslash tricks, the file forms, other letter cases. The edge may rewrite some of these before the
 * Worker sees them, which only a live request shows.
 */
export function probeForms(/** @type {string} */ path) {
  const name = path.slice(1);
  const hex = name.charCodeAt(0).toString(16);
  const rest = name.slice(1);
  const cap = `${name.charAt(0).toUpperCase()}${rest}`;
  return [
    ...new Set([
      path,
      `${path}/`,
      `/%${hex}${rest}`,
      `/%${hex.toUpperCase()}${rest}`,
      `/%${hex}${rest}/`,
      `/%25${hex}${rest}`,
      `/%2e${path}`,
      `/privacy/..${path}`,
      `/x/%2e%2e${path}`,
      `/${path}`,
      `/%2F${name}`,
      `/%5c${name}`,
      `/\\${name}`,
      `${path}.html`,
      `${path}/index.html`,
      `/${cap}`,
      `/${cap}.HTML`,
    ]),
  ];
}

/** What a page's headers must be: _headers for the path, a dynamic page's CSP completed with the file origin. */
function pageExpect(/** @type {Registry} */ reg, /** @type {string} */ path) {
  /** @type {Expect} */
  const out = { status: 200, header: staticHeaders(reg.headersFile, path) };
  const spec = DYNAMIC_PAGES[path];
  if (!spec) return out;
  const csp = /** @type {string} */ (pageCsp(path, { fileOrigin: reg.fileOrigin, r2Endpoint: null }));
  if (spec.r2 && reg.uploadMode === "direct") {
    delete out.header?.["content-security-policy"];
    out.cspIgnoringR2 = csp;
  } else if (out.header) out.header["content-security-policy"] = csp;
  return out;
}

/** @param {Registry} reg @param {"preview" | "open"} mode @returns {Check[]} */
export function checksFor(reg, mode) {
  const origin = reg.publicOrigin;
  const open = mode === "open";
  /** @type {Check[]} */
  const checks = [];
  const variantOf = (/** @type {string} */ path) => reg.variants.find((v) => v.path === path);
  for (const p of reg.pages) {
    const v = variantOf(p.path);
    const url = `${origin}${p.path}`;
    if (open && v?.kind === "preview-only") {
      checks.push({
        what: `preview-only ${p.path} (open)`,
        url,
        expect: { status: 301, header: { location: v.to ?? "/" } },
      });
      continue;
    }
    // In open a variant serves its open file, whose robots line the preview file does not tell.
    const robots = open && v ? {} : p.noindex ? { body: NOINDEX_META } : { bodyNot: NOINDEX_META };
    checks.push({
      what: `page ${p.path}`,
      url,
      links: true,
      expect: { ...pageExpect(reg, p.path), headerAbsent: ["x-robots-tag"], ...robots },
    });
  }
  for (const s of reg.shells) {
    const shown = s.exists ? pageExpect(reg, s.path) : { status: 404 };
    checks.push({
      what: `sign-in page ${s.path} (${mode})`,
      url: `${origin}${s.path}`,
      links: s.exists,
      expect: open
        ? { ...shown, headerAbsent: ["x-robots-tag"] }
        : { ...shown, header: { ...shown.header, "x-robots-tag": "noindex" } },
    });
  }
  const openOnly = reg.variants.filter((v) => v.kind === "open-only").map((v) => v.path);
  if (open) {
    for (const m of reg.members) {
      checks.push({
        what: `member page ${m.path} signed out (open)`,
        url: `${origin}${m.path}`,
        links: m.exists,
        expect: m.exists ? pageExpect(reg, m.path) : { status: 404 },
      });
    }
    for (const path of openOnly) {
      checks.push({
        what: `open-only ${path} (open)`,
        url: `${origin}${path}`,
        links: true,
        expect: pageExpect(reg, path),
      });
    }
  }
  // Signed out in preview a member page is the plain 404, so its probes include the plain path.
  const gated = open ? ["/open"] : [...reg.members.map((m) => m.path), "/open", ...openOnly];
  for (const g of gated) {
    for (const form of probeForms(g)) {
      checks.push({
        what: `gated ${g} as ${form}`,
        url: `${origin}${form}`,
        follow: true,
        expect: { status: 404, body: NOINDEX_META },
      });
    }
  }
  for (const l of reg.lazy) {
    checks.push({
      what: `lazy ${l.path}`,
      url: `${origin}${l.path}`,
      expect: l.type ? { status: 200, contentType: l.type } : { status: 200 },
    });
  }
  // Asked for whatever public/ holds: a build that drops dotfiles loses it.
  checks.push({
    what: "security.txt",
    url: `${origin}/.well-known/security.txt`,
    expect: { status: 200, contentType: "text/plain", body: "Contact:" },
  });
  // The launch manifest is read by the Worker alone; a public request answers the plain 404 in both modes.
  checks.push({
    what: "launch manifest is not served",
    url: `${origin}/_launch.json`,
    expect: { status: 404, body: NOINDEX_META },
  });
  for (const path of reg.typeFiles) {
    checks.push({ what: `type file ${path} is not served`, url: `${origin}${path}`, expect: { status: 404 } });
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

/** A CSP without R2 EU endpoints, directive by directive. */
const withoutR2 = (/** @type {string} */ csp) =>
  csp
    .split("; ")
    .map((d) =>
      d
        .split(" ")
        .filter((t) => !R2_HOST.test(t))
        .join(" "),
    )
    .join("; ");

/** @param {Expect} e @param {Observed} o @returns {string[]} one line per miss */
export function missesFor(e, o) {
  const misses = [];
  const show = (/** @type {string | undefined} */ v) => JSON.stringify(v ?? null);
  if (e.status !== undefined && o.status !== e.status) misses.push(`status ${o.status}, want ${e.status}`);
  if (e.success && (o.status < 200 || o.status > 299)) misses.push(`status ${o.status}, want 2xx`);
  for (const [name, want] of Object.entries(e.header ?? {})) {
    if (o.headers[name] !== want) misses.push(`${name} ${show(o.headers[name])}, want ${show(want)}`);
  }
  for (const [name, bad] of Object.entries(e.headerNot ?? {})) {
    if (o.headers[name] === bad) misses.push(`${name} must not be ${show(bad)}`);
  }
  for (const name of e.headerAbsent ?? []) {
    if (name in o.headers) misses.push(`${name} ${show(o.headers[name])}, want none`);
  }
  const csp = o.headers["content-security-policy"];
  if (e.cspIgnoringR2 !== undefined && (csp === undefined || withoutR2(csp) !== e.cspIgnoringR2)) {
    misses.push(`content-security-policy ${show(csp)}, want ${show(e.cspIgnoringR2)} plus the R2 endpoint`);
  }
  if (e.body !== undefined && !o.body.includes(e.body)) misses.push(`body lacks ${e.body}`);
  if (e.bodyNot !== undefined && o.body.includes(e.bodyNot)) misses.push(`body has ${e.bodyNot}`);
  if (e.contentType !== undefined && !(o.headers["content-type"] ?? "").startsWith(e.contentType)) {
    misses.push(`content-type ${show(o.headers["content-type"])}, want ${e.contentType}`);
  }
  return misses;
}

/**
 * The same-origin `href` and `src` targets in a page, as path plus query, without fragments. Other hosts, and
 * `mailto:`, `tel:`, `data:` and `javascript:`, are not the site's to answer.
 */
export function linksIn(/** @type {string} */ html, /** @type {string} */ pageUrl) {
  const page = new URL(pageUrl);
  const out = new Set();
  for (const m of html.matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (raw === "" || raw.startsWith("#") || /^(mailto|tel|data|javascript):/i.test(raw)) continue;
    const target = new URL(raw, page);
    if (target.host === page.host) out.add(`${target.pathname}${target.search}`);
  }
  return [...out];
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

/** One check: the request, its redirects where it follows them (never to another host), the misses. */
async function runOne(/** @type {Check} */ c, /** @type {Get} */ fetchOnce) {
  // A request that fails to connect is sent once more, a second later: a proxy or network blip is not the site's
  // answer. A second failure is a miss; any answer, whatever its status, is judged as it is.
  const get = (/** @type {string} */ u, /** @type {Record<string, string>} */ h) =>
    fetchOnce(u, h).catch(() => new Promise((r) => setTimeout(r, RETRY_MS)).then(() => fetchOnce(u, h)));
  let url = c.url;
  try {
    let o = await get(url, c.headers ?? {});
    for (let hop = 0; c.follow && hop < MAX_HOPS && o.status >= 300 && o.status < 400 && o.headers.location; hop++) {
      url = new URL(o.headers.location, url).href;
      // Another host's 404 page could carry the same noindex meta and pass.
      if (new URL(url).host !== new URL(c.url).host)
        return { o, misses: [`${c.what}: redirected off its origin to ${url}`] };
      o = await get(url, c.headers ?? {});
    }
    const misses = missesFor(c.expect, o).map((m) => `${c.what}: ${m}${url === c.url ? "" : ` (at ${url})`}`);
    return { o, misses };
  } catch (e) {
    return { o: null, misses: [`${c.what}: request failed: ${/** @type {Error} */ (e).message}`] };
  }
}

/**
 * Runs each check in order, then every same-origin link the checked pages hold, once each: a link must answer 2xx,
 * after same-host redirects. @returns {Promise<{ checks: number, misses: string[] }>}
 */
export async function run(/** @type {Check[]} */ checks, /** @type {Get} */ get = rawGet) {
  const misses = [];
  /** @type {Map<string, string>} link url -> the first page that holds it */
  const links = new Map();
  for (const c of checks) {
    const r = await runOne(c, get);
    misses.push(...r.misses);
    if (c.links && r.o?.status === 200 && (r.o.headers["content-type"] ?? "").startsWith("text/html")) {
      const origin = new URL(c.url).origin;
      for (const l of linksIn(r.o.body, c.url)) if (!links.has(origin + l)) links.set(origin + l, c.url);
    }
  }
  for (const [url, from] of links) {
    const r = await runOne(
      { what: `link ${new URL(url).pathname} (on ${from})`, url, follow: true, expect: { success: true } },
      get,
    );
    misses.push(...r.misses);
  }
  return { checks: checks.length + links.size, misses };
}

/** The CLI. @param {string[]} args @param {Get} [get] @returns {Promise<number>} the exit code */
export async function main(args, get = rawGet) {
  const at = args.indexOf("--mode");
  const mode = at < 0 ? "preview" : args[at + 1];
  const rest = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  const reg = registryFrom();
  if (rest.length !== 1 || (mode !== "preview" && mode !== "open")) {
    console.error("usage: node tools/live-check.mjs <PUBLIC_ORIGIN> [--mode preview|open]");
    return 64;
  }
  // The Worker answers CORS and its redirects for PUBLIC_ORIGIN alone, so any other host would fail for the wrong reason.
  if (rest[0] !== reg.publicOrigin) {
    console.error(`live-check: the origin must be wrangler.jsonc's PUBLIC_ORIGIN, ${reg.publicOrigin}`);
    return 64;
  }
  const result = await run(checksFor(reg, mode), get);
  for (const m of result.misses) console.error(`live-check: ${m}`);
  console.log(`live-check: ${result.checks} checks, ${result.misses.length} misses`);
  return result.misses.length > 0 ? 1 : 0;
}

// Real paths on both sides: run through a symlink (macOS /tmp is one) a plain compare is false and nothing runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  process.exit(await main(process.argv.slice(2)));
