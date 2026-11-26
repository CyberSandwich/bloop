// The v4 foundation: the email normalizer, the new configuration, the file-origin host, and the two rules that keep an
// email member's rows from being deleted by the old Entra-era jobs (ADR 0013).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emailSet, normalizeEmail } from "../../src/worker/auth/email-norm.ts";
import { Sessions } from "../../src/worker/auth/sessions.ts";
import { parseConfig } from "../../src/worker/config.ts";
import { offOrigin } from "../../src/worker/origin.ts";
import { runRetention } from "../../src/worker/retention.ts";
import { PROD_VARS } from "../env-vars.ts";
import { addUser, testDb } from "./d1-shim.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T03:30:00Z");

const config = (over: Record<string, string> = {}) => {
  const r = parseConfig({ ...PROD_VARS, ...over });
  if (!r.ok) throw new Error(r.problems.join());
  return r.config;
};
const problems = (over: Record<string, string>) => {
  const r = parseConfig({ ...PROD_VARS, ...over });
  return r.ok ? [] : r.problems;
};

describe("AUTH-04 email-norm: one normalizer", () => {
  it("AUTH-04 email-norm: trims, lowercases and keeps dots and plus tags", () => {
    expect(normalizeEmail("  Some.One+Tag@Example.TEST ")).toBe("some.one+tag@example.test");
  });

  it("AUTH-04 email-norm: refuses non-ASCII, a missing part, two at signs and an over-long address", () => {
    for (const bad of [
      "josé@example.test",
      "a@b",
      "@example.test",
      "a@@example.test",
      "a b@example.test",
      "",
      "a@example.",
    ]) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    expect(normalizeEmail(`${"a".repeat(250)}@example.test`)).toBeNull();
  });

  it("AUTH-04 email-norm: a list skips an entry that does not normalize, so it admits nobody", () => {
    expect([...emailSet(" A@Example.test, bad ,b@example.test,josé@example.test,,")]).toEqual([
      "a@example.test",
      "b@example.test",
    ]);
    expect(emailSet(undefined).size).toBe(0);
  });
});

describe("v4 configuration", () => {
  it("defaults every v4 variable and leaves every secret absent, so today's configuration still parses", () => {
    const c = config();
    expect(c.library).toMatchObject({ fileOrigin: null, uploadMode: "proxy", convertMode: "off", maxFiles: 2000 });
    expect(c.account).toMatchObject({ deleteGraceDays: 7, reauthSeconds: 300, devMailbox: false });
    expect(Object.values(c.secrets).every((v) => v === null)).toBe(true);
    expect(c.account.adminEmails.size + c.account.testEmails.size).toBe(0);
  });

  it("normalizes ADMIN_EMAILS and TEST_EMAILS at parse", () => {
    const c = config({ ADMIN_EMAILS: "Owner@Example.test", TEST_EMAILS: "t@example.test, T2@example.test" });
    expect(c.account.adminEmails.has("owner@example.test")).toBe(true);
    expect([...c.account.testEmails]).toEqual(["t@example.test", "t2@example.test"]);
  });

  it("MODE-01 config: DEV_MAILBOX is refused on an https origin and allowed on a local one", () => {
    expect(problems({ DEV_MAILBOX: "1" })).toEqual(["DEV_MAILBOX: refused: PUBLIC_ORIGIN is not a local address"]);
    expect(
      config({ DEV_MAILBOX: "1", PUBLIC_ORIGIN: "http://localhost:8787", TEST_TIMING: "0" }).account.devMailbox,
    ).toBe(true);
  });

  it("R2_DEV_ENDPOINT and CONVERT_MODE=stub are refused on a deployed origin and allowed on a local one", () => {
    expect(problems({ R2_DEV_ENDPOINT: "http://127.0.0.1:9000" })).toEqual([
      "R2_DEV_ENDPOINT: refused: PUBLIC_ORIGIN is not a local address",
    ]);
    expect(problems({ CONVERT_MODE: "stub" })).toEqual([
      "CONVERT_MODE: stub refused: PUBLIC_ORIGIN is not a local address",
    ]);
    const local = { PUBLIC_ORIGIN: "http://localhost:8787", TEST_TIMING: "0" };
    expect(config({ ...local, R2_DEV_ENDPOINT: "http://127.0.0.1:9000" }).library.r2DevEndpoint).toBe(
      "http://127.0.0.1:9000",
    );
    expect(config({ ...local, CONVERT_MODE: "stub" }).library.convertMode).toBe("stub");
    expect(config().library.r2DevEndpoint).toBeNull();
  });

  it("wrangler.jsonc never sets a test-only variable", () => {
    const live = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(live).not.toMatch(/"(R2_DEV_ENDPOINT|DEV_MAILBOX|TEST_TIMING)"\s*:/);
    expect(live).not.toMatch(/"CONVERT_MODE"\s*:\s*"stub"/);
  });

  it("FILE_ORIGIN must be an origin, differ from PUBLIC_ORIGIN and be https unless local; empty means off", () => {
    expect(config({ FILE_ORIGIN: "" }).library.fileOrigin).toBeNull();
    expect(config({ FILE_ORIGIN: "https://files.example" }).library.fileOrigin).toBe("https://files.example");
    expect(problems({ FILE_ORIGIN: "https://files.example/x" })).toHaveLength(1);
    expect(problems({ FILE_ORIGIN: "https://bloop.example" })).toEqual(["FILE_ORIGIN: must differ from PUBLIC_ORIGIN"]);
    expect(problems({ FILE_ORIGIN: "http://files.example" })).toEqual(["FILE_ORIGIN: must be https"]);
  });

  it("holds the presigned URL life and the part size to their ranges", () => {
    expect(problems({ UPLOAD_URL_TTL_SECONDS: "901" })).toHaveLength(1);
    expect(problems({ UPLOAD_PART_BYTES: "5242879" })).toHaveLength(1);
    expect(config({ UPLOAD_URL_TTL_SECONDS: "300" }).library.urlTtlSeconds).toBe(300);
  });

  it("a weak secret fails the parse and a missing one does not", () => {
    expect(problems({ CODE_PEPPER: "short" })).toHaveLength(1);
    expect(config({ CODE_PEPPER: "x".repeat(43) }).secrets.codePepper).toHaveLength(43);
  });
});

describe("wrangler.jsonc: platform features that must stay off", () => {
  const live = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("ADR 0023: Workers Cache is not configured and no Workflow is bound", () => {
    expect(live).not.toMatch(/"cache"\s*:/);
    expect(live).not.toMatch(/"workflows"\s*:/);
  });

  it("no local run starts the converter container", () => {
    expect(live).toMatch(/"dev"\s*:\s*\{\s*"enable_containers"\s*:\s*false/);
  });
});

describe("FO-01 host: the file-origin host", () => {
  const FILE = "https://files.example";
  const OWN = "https://bloop.example";

  it("FO-01 host: answers /fo/ping itself and nothing else", () => {
    expect(offOrigin(new Request(`${FILE}/fo/ping`), OWN, FILE)).toBeNull();
    const other = offOrigin(new Request(`${FILE}/privacy?x=1`), OWN, FILE);
    expect(other?.status).toBe(301);
    expect(other?.headers.get("Location")).toBe(`${OWN}/privacy?x=1`);
    expect(offOrigin(new Request(`${FILE}/api/screens`, { method: "POST" }), OWN, FILE)?.status).toBe(403);
  });

  it("FO-01 host: a workers.dev file host redirects every path but /fo/ping to PUBLIC_ORIGIN", () => {
    const workers = "https://bloop.dsap.workers.dev";
    expect(offOrigin(new Request(`${workers}/fo/ping`), OWN, workers)).toBeNull();
    const moved = offOrigin(new Request(`${workers}/f/token/name.pptx?a=1`), OWN, workers);
    expect(moved?.status).toBe(301);
    expect(moved?.headers.get("Location")).toBe(`${OWN}/f/token/name.pptx?a=1`);
    expect(offOrigin(new Request(`${workers}/api/screens`, { method: "POST" }), OWN, workers)?.status).toBe(403);
  });

  it("FO-01 host: with no file origin configured /fo/ping on workers.dev is redirected like any path", () => {
    expect(offOrigin(new Request("https://bloop.dsap.workers.dev/fo/ping"), OWN)?.status).toBe(301);
  });
});

describe("LIB-09 sweep: the user-row sweep never deletes an email member", () => {
  const addEmailUser = (db: ReturnType<typeof testDb>, id: string, lastSeen: number) =>
    db.raw
      .prepare(
        "INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES (?, 'email', ?, ?, ?, 0, ?)",
      )
      .run(id, id, `${id}@example.test`, `${id}@example.test`, lastSeen);

  it("LIB-09 sweep: an email member with no session survives 400 days of silence, an Entra user does not", async () => {
    const db = testDb();
    addEmailUser(db, "member", NOW - 400 * DAY);
    addUser(db, "entra");
    db.raw.prepare("UPDATE app_user SET last_seen_at = ? WHERE id = 'entra'").run(NOW - 400 * DAY);
    db.raw
      .prepare(
        "INSERT INTO library_file (id, user_id, name, ext, bytes, r2_key, status, created_at, updated_at) VALUES ('f1', 'member', 'a.pdf', 'pdf', 1, 'u/member/f1/v1/orig', 'ready', 0, 0)",
      )
      .run();
    const report = await runRetention({ DB: db }, config(), NOW);
    expect(report.userRows).toBe(1);
    expect(db.raw.prepare("SELECT id FROM app_user").all()).toEqual([{ id: "member" }]);
    expect(db.raw.prepare("SELECT count(*) AS n FROM library_file").get()).toEqual({ n: 1 });
  });
});

describe("LIB-08 erase: an email member is handed to the purge, never deleted in place", () => {
  it("LIB-08 erase: Sessions.deleteUser leaves an email row and its library rows alone", async () => {
    const db = testDb();
    db.raw
      .prepare(
        "INSERT INTO app_user (id, tid, oid, email_norm, created_at, last_seen_at) VALUES ('m', 'email', 'm', 'm@example.test', 0, 0)",
      )
      .run();
    db.raw
      .prepare(
        "INSERT INTO library_file (id, user_id, name, ext, bytes, r2_key, status, created_at, updated_at) VALUES ('f1', 'm', 'a.pdf', 'pdf', 1, 'u/m/f1/v1/orig', 'ready', 0, 0)",
      )
      .run();
    addUser(db, "e");
    const sessions = new Sessions(db, () => NOW);
    await sessions.deleteUser("m");
    await sessions.deleteUser("e");
    expect(db.raw.prepare("SELECT id FROM app_user").all()).toEqual([{ id: "m" }]);
    expect(db.raw.prepare("SELECT count(*) AS n FROM library_file").get()).toEqual({ n: 1 });
  });

  it("LIB-08 erase: requestDeletion starts the grace for an active email member only, and repeating it changes nothing", async () => {
    const db = testDb();
    db.raw
      .prepare(
        "INSERT INTO app_user (id, tid, oid, email_norm, created_at, last_seen_at) VALUES ('m', 'email', 'm', 'm@example.test', 0, 0)",
      )
      .run();
    addUser(db, "e");
    const sessions = new Sessions(db, () => NOW);
    expect(await sessions.emailNorm("m")).toBe("m@example.test");
    expect(await sessions.emailNorm("e")).toBeNull();
    await sessions.requestDeletion("m", NOW + 7 * DAY, "kept");
    await sessions.requestDeletion("m", NOW + 99 * DAY, "kept");
    await sessions.requestDeletion("e", NOW + 7 * DAY, "kept");
    expect(db.raw.prepare("SELECT id, status, delete_after FROM app_user ORDER BY id").all()).toEqual([
      { id: "e", status: "active", delete_after: null },
      { id: "m", status: "deleting", delete_after: NOW + 7 * DAY },
    ]);
  });
});
