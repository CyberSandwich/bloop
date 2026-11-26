// HASH_PEPPER keys several HMACs. The pid secret's input is "pid:" + nonce (seams/pairing/idem.ts), so no other input
// may ever read "pid:...": each call site is listed with why its input space cannot, and a new one fails until listed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALPHABET } from "../../public/js/shared/codes.js";
import { drawCode, newRef, newSecret } from "../../src/worker/ids.ts";

const root = new URL("../../", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });

/** `<file>: <the keyed call>` for every HMAC under the pepper, and why its input never starts with "pid:". */
const SITES: Record<string, string> = {
  "src/worker/rate-limit.ts: hmacHex(config.hashPepper, clientIp(request))":
    "an IP literal or 'local': hex digits, dots and colons, and 'p' and 'i' are no hex digit",
  'src/worker/auth/codes.ts: hmacHex(\n    pepper,\n    [m.id, m.purpose, m.emailNorm, m.newEmailNorm ?? "", m.code].map((f) => `${f.length}:${f}`).join("|"),\n  )':
    "length-prefixed fields: it starts with the id's length, a digit",
  "src/worker/auth/codes.ts: hmacHex(pepper, `dev|${userId}|${epoch}|${nonce}`)": "it starts with 'dev|'",
  "src/worker/routes/common.ts: hmacHex(config.hashPepper, network(clientIp(request)))":
    "an IPv4 address or an IPv6 /64 in hex groups: no 'p' or 'i'",
  "src/worker/metrics-d1.ts: hmacHex(this.pepper, userId)": "a user id is newRef(): base64url, never a colon",
  "src/worker/do/screen.ts: claimSecret(pepper, nonce)": "the pid secret itself: 'pid:' + a base64url nonce",
  "src/worker/seams/pairing/idem.ts: claimSecret(pepper, s.nonce)": "the same secret, derived again for a replay",
  'src/worker/seams/pairing/idem.ts: subKeyMac(pepper, "bloop pid", `pid:${nonce}`)':
    "claimSecret's own HMAC, under the 'bloop pid' sub-key",
  'src/worker/seams/pairing/idem.ts: subKeyMac(pepper, "bloop device", nonce)':
    "a device nonce, under its own 'bloop device' sub-key: never the pid's key",
};

describe("REL-14 pepper domains", () => {
  it("REL-14 pepper domains: every HMAC under HASH_PEPPER is listed, so none can read 'pid:' + nonce", () => {
    const found = walk("src").flatMap((path) =>
      // A call with its arguments, nested two calls deep; a definition (`function name(`) is no call site.
      [
        ...readFileSync(join(root, path), "utf8").matchAll(
          /(?<!function )(?:hmacHex|claimSecret|subKeyMac)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g,
        ),
      ]
        .map((m) => m[0])
        .filter((call) => /pepper|Pepper/i.test(call))
        .map((call) => `${path}: ${call}`),
    );
    expect(found.sort()).toEqual(Object.keys(SITES).sort());
  });

  it("REL-14 pepper domains: codes, refs and secrets hold no colon, so none of them reads 'pid:'", () => {
    expect(ALPHABET).not.toContain(":");
    for (let i = 0; i < 50; i++) {
      expect(drawCode(6)).toMatch(/^[^:]+$/);
      expect(newRef()).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(newSecret()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
