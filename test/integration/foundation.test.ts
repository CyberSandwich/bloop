// The v4 foundation against a real wrangler dev: the launch-mode page gate, the /fo/ping file host, and the guard that
// keeps an email member's rows out of the Entra-era erase (ADR 0013). The page files themselves arrive with the account
// streams; these tests hold the gate that fronts them.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;

beforeAll(async () => {
  // The erase route lives behind the Entra configuration; the fake authority is never contacted here.
  const key = Buffer.alloc(32, 7).toString("base64");
  wrangler = await startPairing(
    {
      FILE_SOURCE: "graph",
      ENTRA_AUTHORITY: "http://127.0.0.1:9/organizations/v2.0",
      ENTRA_CLIENT_ID: "client-id-1",
      ENTRA_CLIENT_SECRET: `app-${"c".repeat(12)}`,
      TOKEN_KEKS: JSON.stringify({ k1: key }),
      COOKIE_KEY: key,
    },
    { migrate: true },
  );
  api = new Api(wrangler.url);
});
afterAll(async () => {
  await wrangler?.stop();
});

const setMode = (mode: "preview" | "open", lockout = false) => {
  wrangler.d1(`INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('launch_mode', '${mode}', 0)`);
  wrangler.d1("DELETE FROM setting WHERE key = 'preview_lockout'");
  if (lockout) wrangler.d1("INSERT INTO setting (key, value, updated_at) VALUES ('preview_lockout', '1', 0)");
};
const hit = (path: string) => fetch(`${wrangler.url}${path}`, { redirect: "manual" });

const OPEN_FORMS = ["/open/", "/open", "/Open/", "/OPEN/x", "/%6Fpen/", "//open/", "/./open/", "/%5Copen/"];

describe("MODE-01 gate: the launch mode against a real D1", () => {
  for (const [mode, lockout] of [
    ["preview", false],
    ["preview", true],
    ["open", false],
  ] as const) {
    const label = `${mode}${lockout ? " with the lockout" : ""}`;

    it(`MODE-01 gate: every form of /open is the same 404 as an unknown path in ${label}`, async () => {
      setMode(mode, lockout);
      const unknown = await hit("/no-such-page");
      expect(unknown.status).toBe(404);
      const unknownBody = await unknown.text();
      for (const form of OPEN_FORMS) {
        const res = await hit(form);
        expect(res.status, form).toBe(404);
        expect(await res.text(), form).toBe(unknownBody);
      }
    });

    it(`MODE-01 gate: today's pages answer and signed-out /library, /account, /admin never fail in ${label}`, async () => {
      setMode(mode, lockout);
      expect((await hit("/privacy")).status).toBe(200);
      expect((await hit("/")).status).toBe(200);
      for (const path of ["/library", "/account", "/admin"]) expect((await hit(path)).status, path).toBeLessThan(500);
    });
  }

  it("MODE-01 gate: a missing setting row and an unknown value both read as preview", async () => {
    wrangler.d1("DELETE FROM setting");
    expect((await hit("/open/")).status).toBe(404);
    wrangler.d1("INSERT INTO setting (key, value, updated_at) VALUES ('launch_mode', 'OPEN', 0)");
    expect((await hit("/privacy")).status).toBe(200);
  });
});

describe("REL-03 marker: every API answer carries X-Bloop", () => {
  it("REL-03 marker: a success, a 404 and a refused write all carry X-Bloop: 1", async () => {
    expect((await hit("/api/health")).headers.get("X-Bloop")).toBe("1");
    expect((await hit("/api/no-such-route")).headers.get("X-Bloop")).toBe("1");
    const refused = await fetch(`${wrangler.url}/api/screens`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(refused.headers.get("X-Bloop")).toBe("1");
  });
});

describe("FO-01 host: /fo/ping", () => {
  it("FO-01 host: with no file origin configured the path answers 404 with no CORS header", async () => {
    const res = await hit("/fo/ping");
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("LIB-09 sweep: the daily retention run", () => {
  it("LIB-09 sweep: keeps an email member silent for 400 days with their library rows, and removes an Entra user", async () => {
    const old = Date.now() - 400 * 86_400_000;
    wrangler.d1(
      `INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('sw-email', 'email', 'sw-email', 'sw@example.test', 'sw@example.test', 0, ${old})`,
    );
    wrangler.d1(
      `INSERT INTO app_user (id, tid, oid, created_at, last_seen_at) VALUES ('sw-entra', 'tenant-a', 'sw-entra', 0, ${old})`,
    );
    wrangler.d1(
      "INSERT INTO library_file (id, user_id, name, ext, bytes, r2_key, status, created_at, updated_at) VALUES ('sw1', 'sw-email', 'a.pdf', 'pdf', 1, 'u/sw-email/sw1/v1/orig', 'ready', 0, 0)",
    );
    const res = await fetch(`${wrangler.url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("30 3 * * *")}`);
    expect(res.status).toBe(200);
    expect(wrangler.d1("SELECT id FROM app_user WHERE id LIKE 'sw-%' ORDER BY id")).toEqual([{ id: "sw-email" }]);
    expect(wrangler.d1("SELECT count(*) AS n FROM library_file WHERE id = 'sw1'")[0]?.n).toBe(1);
  });
});

describe("LIB-08 erase: DELETE /api/me for an email member", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  it("LIB-08 erase: needs a fresh proof, then marks the member deleting, ends their sessions and keeps their rows", async () => {
    const day = 86_400_000;
    wrangler.d1(
      "INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('em1', 'email', 'em1', 'm@example.test', 'm@example.test', 0, 0)",
    );
    const cookie = "E".repeat(43);
    const now = Date.now();
    wrangler.d1(
      `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, reauth_at) VALUES ('${sha(cookie)}', 'em1', ${now}, ${now}, ${now + 30 * day}, NULL)`,
    );
    wrangler.d1(
      "INSERT INTO library_file (id, user_id, name, ext, bytes, r2_key, status, created_at, updated_at) VALUES ('lf1', 'em1', 'a.pdf', 'pdf', 1, 'u/em1/lf1/v1/orig', 'ready', 0, 0)",
    );

    const headers = { Cookie: `__Host-bloop_sid=${cookie}` };
    // Without a fresh proof the request is refused and nothing changes.
    expect((await api.call("DELETE", "/api/me", {}, { headers })).status).toBe(401);
    expect(wrangler.d1("SELECT status FROM app_user WHERE id = 'em1'")[0]?.status).toBe("active");
    wrangler.d1(`UPDATE phone_session SET reauth_at = ${Date.now()} WHERE user_id = 'em1'`);

    const res = await api.call("DELETE", "/api/me", {}, { headers });
    expect(res.status).toBe(200);
    expect(wrangler.d1("SELECT count(*) AS n FROM phone_session WHERE user_id = 'em1'")[0]?.n).toBe(0);

    const [user] = wrangler.d1("SELECT status, delete_after FROM app_user WHERE id = 'em1'");
    expect(user?.status).toBe("deleting");
    const after = Number(user?.delete_after);
    expect(after).toBeGreaterThan(now + 6 * day);
    expect(after).toBeLessThan(now + 8 * day);
    expect(wrangler.d1("SELECT count(*) AS n FROM library_file WHERE user_id = 'em1'")[0]?.n).toBe(1);
    expect(wrangler.d1("SELECT count(*) AS n FROM app_user WHERE id = 'em1'")[0]?.n).toBe(1);
  });
});
