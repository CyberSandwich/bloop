// Resolves public/_headers for one path the way Cloudflare does: matching blocks in order, `! Name` detaches.
// One resolver for test/unit/headers.test.ts and tools/live-check.mjs, so both expect the same headers.

/**
 * A `_headers` rule as a regex: one `*` splat and `:name` placeholders only, as Cloudflare allows.
 * @param {string} rule
 */
function rulePattern(rule) {
  if (rule.split("*").length > 2) throw new Error(`${rule}: a rule may hold one splat`);
  const source = rule
    .split(/(:[A-Za-z]\w*|\*)/)
    .map((part) => (part === "*" ? ".*" : part.startsWith(":") ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/**
 * @param {string} text the _headers file @param {string} path an exact page path
 * @param {string} [host] the request's host; a rule written as `https://host/path` applies to that host only
 * @returns {Record<string, string>} lower-case names
 */
export function staticHeaders(text, path, host = "bloop.here") {
  const out = new Map();
  let applies = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      const ruleHost = /^https:\/\/([^/]+)(\/.*)$/.exec(line);
      applies = ruleHost ? ruleHost[1] === host && rulePattern(ruleHost[2] ?? "").test(path) : rulePattern(line).test(path);
      continue;
    }
    if (!applies) continue;
    const entry = line.trim();
    if (entry.startsWith("! ")) {
      out.delete(entry.slice(2).toLowerCase());
      continue;
    }
    const colon = entry.indexOf(":");
    const name = entry.slice(0, colon).trim().toLowerCase();
    // Cloudflare joins repeated names with a comma, which would corrupt a CSP; every override must detach first.
    if (out.has(name)) throw new Error(`${path}: ${name} set twice without detaching`);
    out.set(name, entry.slice(colon + 1).trim());
  }
  return Object.fromEntries(out);
}
