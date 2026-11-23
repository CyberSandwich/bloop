import { describe, expect, it, vi } from "vitest";
import { bytes } from "../../src/worker/auth/db.ts";
import { type Refresh, Vault } from "../../src/worker/auth/vault.ts";
import { addUser, testDb } from "./d1-shim.ts";

const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const K1 = key(1);
const K2 = key(2);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(keys: Record<string, string> = { k1: K1 }, current = "k1", clock = { t: 1_000_000_000_000 }) {
  const db = testDb();
  addUser(db, "u1");
  addUser(db, "u2");
  const vault = new Vault(db, { keys, current }, () => clock.t);
  return { db, vault, clock };
}

const grant = (over = {}) => ({
  refreshToken: "refresh-secret-1",
  accessToken: "access-secret-1",
  accessExpiresAt: 1_000_000_000_000 + HOUR,
  scope: "openid offline_access Files.Read",
  ...over,
});

const neverRefresh: Refresh = async () => {
  throw new Error("refresh must not be called");
};

describe("AUTH-01 vault: encryption at rest", () => {
  it("AUTH-01 vault: stores ciphertext only and round-trips the access token", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    const row = db.raw.prepare("SELECT * FROM token_grant WHERE user_id = 'u1'").get() as Record<string, unknown>;
    const dump = JSON.stringify(Object.values(row).map((v) => (v instanceof Uint8Array ? Array.from(v) : v)));
    for (const secret of ["refresh-secret-1", "access-secret-1"]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(Array.from(new TextEncoder().encode(secret)).join(","));
    }
    expect(row.kid).toBe("k1");
    expect(row.version).toBe(1);
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: true, token: "access-secret-1" });
  });

  it("AUTH-01 vault: a row copied to another user fails to decrypt (AAD binds user and version)", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    db.raw.exec("UPDATE token_grant SET user_id = 'u2' WHERE user_id = 'u1'");
    await expect(vault.accessToken("u2", neverRefresh)).rejects.toThrow();
  });

  it("AUTH-01 vault: a tampered ciphertext fails to decrypt", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    const row = db.raw.prepare("SELECT at_ct FROM token_grant WHERE user_id = 'u1'").get() as { at_ct: Uint8Array };
    const flipped = Uint8Array.from(bytes(row.at_ct));
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    db.raw.prepare("UPDATE token_grant SET at_ct = ? WHERE user_id = 'u1'").run(flipped);
    await expect(vault.accessToken("u1", neverRefresh)).rejects.toThrow();
  });

  it("AUTH-01 vault: a tampered wrapped key fails to unwrap", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    const row = db.raw.prepare("SELECT dek_wrapped FROM token_grant").get() as { dek_wrapped: Uint8Array };
    const flipped = Uint8Array.from(bytes(row.dek_wrapped));
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    db.raw.prepare("UPDATE token_grant SET dek_wrapped = ?").run(flipped);
    await expect(vault.accessToken("u1", neverRefresh)).rejects.toThrow();
  });

  it("AUTH-01 vault: the wrong key cannot open a grant", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    const wrong = new Vault(db, { keys: { k1: K2 }, current: "k1" });
    await expect(wrong.accessToken("u1", neverRefresh)).rejects.toThrow();
  });

  it("AUTH-01 vault: an unknown kid is an error, not a silent pass", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    const other = new Vault(db, { keys: { k9: K2 }, current: "k9" });
    await expect(other.accessToken("u1", neverRefresh)).rejects.toThrow(/unknown KEK/);
  });

  it("AUTH-01 vault: each store draws a fresh data key and IV", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    await vault.store("u2", grant());
    const rows = db.raw.prepare("SELECT dek_wrapped, at_iv FROM token_grant").all() as {
      dek_wrapped: Uint8Array;
      at_iv: Uint8Array;
    }[];
    expect(Array.from(rows[0]?.dek_wrapped ?? [])).not.toEqual(Array.from(rows[1]?.dek_wrapped ?? []));
    expect(Array.from(rows[0]?.at_iv ?? [])).not.toEqual(Array.from(rows[1]?.at_iv ?? []));
  });
});

describe("AUTH-01 vault: KEK rotation", () => {
  it("AUTH-01 vault: an old kid still decrypts, a use re-wraps under the current kid, new writes use it", async () => {
    const { db, vault, clock } = setup();
    await vault.store("u1", grant());
    const rotated = new Vault(db, { keys: { k1: K1, k2: K2 }, current: "k2" }, () => clock.t);
    expect(await rotated.staleCount()).toBe(1);
    expect(await rotated.accessToken("u1", neverRefresh)).toEqual({ ok: true, token: "access-secret-1" });
    expect(db.raw.prepare("SELECT kid FROM token_grant WHERE user_id = 'u1'").get()).toEqual({ kid: "k2" });
    expect(await rotated.staleCount()).toBe(0);

    await rotated.store("u2", grant());
    expect(db.raw.prepare("SELECT kid FROM token_grant WHERE user_id = 'u2'").get()).toEqual({ kid: "k2" });

    // With k1 deleted from the config, everything still opens.
    const afterDelete = new Vault(db, { keys: { k2: K2 }, current: "k2" }, () => clock.t);
    expect(await afterDelete.accessToken("u1", neverRefresh)).toEqual({ ok: true, token: "access-secret-1" });
  });

  it("AUTH-01 vault: the cron re-wraps unused grants and reports how many are left", async () => {
    const { db, vault, clock } = setup();
    await vault.store("u1", grant());
    await vault.store("u2", grant());
    const rotated = new Vault(db, { keys: { k1: K1, k2: K2 }, current: "k2" }, () => clock.t);
    expect(await rotated.rewrapStale(1)).toBe(1);
    expect(await rotated.rewrapStale(10)).toBe(0);
    const afterDelete = new Vault(db, { keys: { k2: K2 }, current: "k2" }, () => clock.t);
    expect(await afterDelete.accessToken("u2", neverRefresh)).toEqual({ ok: true, token: "access-secret-1" });
  });
});

describe("AUTH-02 cas: refresh", () => {
  const fresh = (n: number): Awaited<ReturnType<Refresh>> => ({
    ok: true,
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: 1_000_000_000_000 + 3 * HOUR,
  });

  it("AUTH-02 cas: an expired access token is refreshed, both tokens replaced, version bumped", async () => {
    const { db, vault, clock } = setup();
    await vault.store("u1", grant());
    clock.t += 2 * HOUR;
    const refresh = vi.fn<Refresh>(async () => fresh(2));
    expect(await vault.accessToken("u1", refresh)).toEqual({ ok: true, token: "access-2" });
    expect(refresh).toHaveBeenCalledWith("refresh-secret-1");
    expect(db.raw.prepare("SELECT version FROM token_grant").get()).toEqual({ version: 2 });
    // The new refresh token is what the next refresh presents.
    clock.t += 4 * HOUR;
    const second = vi.fn<Refresh>(async () => fresh(3));
    await vault.accessToken("u1", second);
    expect(second).toHaveBeenCalledWith("refresh-2");
  });

  it("AUTH-02 cas: a valid cached token is served without calling the token endpoint", async () => {
    const { vault } = setup();
    await vault.store("u1", grant());
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: true, token: "access-secret-1" });
  });

  it("AUTH-02 cas: a token within a minute of expiry is refreshed", async () => {
    const { vault, clock } = setup();
    await vault.store("u1", grant());
    clock.t += HOUR - 30_000;
    const refresh = vi.fn<Refresh>(async () => fresh(2));
    await vault.accessToken("u1", refresh);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("AUTH-02 cas: concurrent refreshes leave one consistent row and both callers get a working token", async () => {
    const { db, vault, clock } = setup();
    await vault.store("u1", grant());
    clock.t += 2 * HOUR;
    let n = 1;
    const refresh: Refresh = async () => {
      await new Promise((r) => setTimeout(r, 5));
      n += 1;
      return fresh(n);
    };
    const results = await Promise.all([vault.accessToken("u1", refresh), vault.accessToken("u1", refresh)]);
    for (const r of results) expect(r.ok).toBe(true);
    // Exactly one writer won the swap; the row is at version 2 and opens cleanly.
    expect(db.raw.prepare("SELECT version FROM token_grant").get()).toEqual({ version: 2 });
    // The loser serves the winner's stored token rather than overwriting it with a stale one.
    const stored = await vault.accessToken("u1", neverRefresh);
    expect(results).toEqual([stored, stored]);
  });

  it("AUTH-02 cas: many concurrent refreshes never corrupt the row", async () => {
    const { db, vault, clock } = setup();
    await vault.store("u1", grant());
    clock.t += 2 * HOUR;
    let n = 1;
    const refresh: Refresh = async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      n += 1;
      return fresh(n);
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => vault.accessToken("u1", refresh)));
    expect(results.every((r) => r.ok)).toBe(true);
    const version = (db.raw.prepare("SELECT version FROM token_grant").get() as { version: number }).version;
    expect(version).toBe(2);
    expect((await vault.accessToken("u1", neverRefresh)).ok).toBe(true);
  });

  it("AUTH-02 cas: a revoked refresh token deletes the grant and asks for sign-in", async () => {
    const { vault, clock } = setup();
    await vault.store("u1", grant());
    clock.t += 2 * HOUR;
    const dead: Refresh = async () => ({ ok: false, error: "auth_required", revoked: true });
    expect(await vault.accessToken("u1", dead)).toEqual({ ok: false, error: "auth_required" });
    expect(await vault.has("u1")).toBe(false);
  });

  it("AUTH-02 cas: a transient refresh failure keeps the grant", async () => {
    const { vault, clock } = setup();
    await vault.store("u1", grant());
    clock.t += 2 * HOUR;
    const down: Refresh = async () => ({ ok: false, error: "source_throttled", revoked: false });
    expect(await vault.accessToken("u1", down)).toEqual({ ok: false, error: "source_throttled" });
    expect(await vault.has("u1")).toBe(true);
  });

  it("AUTH-02 cas: no grant means auth_required", async () => {
    const { vault } = setup();
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: false, error: "auth_required" });
  });

  it("AUTH-02 cas: a second sign-in replaces the grant and bumps the version", async () => {
    const { db, vault } = setup();
    await vault.store("u1", grant());
    await vault.store("u1", grant({ accessToken: "access-again" }));
    expect(db.raw.prepare("SELECT version FROM token_grant").get()).toEqual({ version: 2 });
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: true, token: "access-again" });
  });
});

describe("AUTH-01 vault: TOKEN_MODE=session and retention", () => {
  it("AUTH-01 vault: session mode holds no refresh token, and an expired access token needs sign-in", async () => {
    const { db, vault, clock } = setup();
    await vault.store("u1", grant({ refreshToken: null }));
    expect(db.raw.prepare("SELECT rt_ct, rt_iv FROM token_grant").get()).toEqual({ rt_ct: null, rt_iv: null });
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: true, token: "access-secret-1" });
    clock.t += 2 * HOUR;
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: false, error: "auth_required" });
  });

  it("AUTH-01 vault: grants unused for GRANT_IDLE_DAYS are deleted, used ones are kept", async () => {
    const { vault, clock } = setup();
    await vault.store("u1", grant());
    await vault.store("u2", grant());
    clock.t += 20 * DAY;
    const refresh: Refresh = async () => ({
      ok: true,
      accessToken: "a",
      refreshToken: null,
      expiresAt: clock.t + HOUR,
    });
    await vault.accessToken("u1", refresh); // a use at day 20
    clock.t += 15 * DAY; // u2 idle 35 days, u1 idle 15
    expect(await vault.deleteIdle(30)).toBe(1);
    expect(await vault.has("u1")).toBe(true);
    expect(await vault.has("u2")).toBe(false);
  });

  it("AUTH-07 disconnect: delete removes the grant at once", async () => {
    const { vault } = setup();
    await vault.store("u1", grant());
    await vault.delete("u1");
    expect(await vault.accessToken("u1", neverRefresh)).toEqual({ ok: false, error: "auth_required" });
  });

  it("AUTH-06 scope: the folder the listing is limited to is stored with the grant", async () => {
    const { vault } = setup();
    await vault.store("u1", grant({ folderId: "folder-1" }));
    expect(await vault.folderId("u1")).toBe("folder-1");
    expect(await vault.folderId("u2")).toBeNull();
  });
});
