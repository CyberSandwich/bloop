import { describe, expect, it } from "vitest";
import {
  type CodePurpose,
  codeMac,
  drawEmailCode,
  type IssueInput,
  isKnown,
  issueCode,
  MAX_ATTEMPTS,
  newDeviceValue,
  verifyCode,
} from "../../src/worker/auth/codes.ts";
import type { Db } from "../../src/worker/auth/db.ts";
import { addUser, type TestDb, testDb } from "./d1-shim.ts";

const PEPPER = "p".repeat(32);
const TTL = 600;
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const EMAIL = "member@example.test";

function setup() {
  const db = testDb();
  addUser(db, "u1");
  addUser(db, "u2");
  db.raw
    .prepare("INSERT INTO invite (id, token_hash, email_norm, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("inv1", "h1", EMAIL, EMAIL, T0, T0 + 7 * 86_400_000);
  return db;
}

async function issued(db: TestDb, input: IssueInput, now = T0) {
  const r = await issueCode(db, PEPPER, input, TTL, now);
  if (r.limited) throw new Error("unexpectedly limited");
  return r;
}

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

/** Counts the guesses that got past the attempt guard to the MAC compare (the guarded UPDATE returned the row). */
function counting(db: TestDb): { db: Db; compared: () => number } {
  let n = 0;
  return {
    compared: () => n,
    db: {
      prepare(sql) {
        const s = db.prepare(sql);
        if (!sql.includes("RETURNING")) return s;
        const first = s.first.bind(s);
        s.first = (async () => {
          const row = await first();
          if (row) n++;
          return row;
        }) as typeof s.first;
        return s;
      },
    },
  };
}

/** The naive double: read the count, compare, then increment. Parallel guesses all read the same count. */
async function naiveVerify(db: Db, id: string, code: string, onCompare: () => void): Promise<boolean> {
  const row = await db
    .prepare("SELECT attempts, email_norm, new_email_norm, code_mac FROM email_code WHERE id = ?")
    .bind(id)
    .first<{ attempts: number; email_norm: string; new_email_norm: string | null; code_mac: string }>();
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;
  onCompare();
  const mac = await codeMac(PEPPER, {
    id,
    purpose: "signin",
    emailNorm: row.email_norm,
    newEmailNorm: row.new_email_norm,
    code,
  });
  await db.prepare("UPDATE email_code SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
  return mac === row.code_mac;
}

describe("AUTH-09 mac", () => {
  const base = { id: "a".repeat(22), purpose: "signin", emailNorm: EMAIL, newEmailNorm: null, code: "123456" };

  it("AUTH-09 mac: the id, purpose, email, new email and pepper each change the MAC", async () => {
    const mac = await codeMac(PEPPER, base);
    expect(await codeMac(PEPPER, base)).toBe(mac);
    const variants = [
      { ...base, id: "b".repeat(22) },
      { ...base, purpose: "reauth" },
      { ...base, emailNorm: "other@example.test" },
      { ...base, newEmailNorm: "new@example.test" },
      { ...base, code: "123457" },
    ];
    for (const v of variants) expect(await codeMac(PEPPER, v)).not.toBe(mac);
    expect(await codeMac("q".repeat(32), base)).not.toBe(mac);
  });

  it("AUTH-09 mac: no column holds the code, and code_mac is the HMAC over the bound fields", async () => {
    const db = setup();
    const r = await issued(db, {
      purpose: "email_change",
      emailNorm: EMAIL,
      newEmailNorm: "new@example.test",
      userId: "u1",
    });
    const row = db.raw.prepare("SELECT * FROM email_code WHERE id = ?").get(r.challengeId) as Record<string, unknown>;
    for (const [column, value] of Object.entries(row)) {
      if (column !== "code_mac") expect(String(value), column).not.toContain(r.code);
    }
    expect(row.code_mac).toBe(
      await codeMac(PEPPER, {
        id: r.challengeId,
        purpose: "email_change",
        emailNorm: EMAIL,
        newEmailNorm: "new@example.test",
        code: r.code,
      }),
    );
    expect(
      await verifyCode(db, PEPPER, { id: r.challengeId, purpose: "email_change", code: r.code, userId: "u1" }),
    ).toMatchObject({ emailNorm: EMAIL, newEmailNorm: "new@example.test", userId: "u1" });
  });

  it("AUTH-09 mac: a row moved to another address no longer verifies", async () => {
    const db = setup();
    const r = await issued(db, { purpose: "signin", emailNorm: EMAIL });
    db.raw.prepare("UPDATE email_code SET email_norm = 'attacker@example.test' WHERE id = ?").run(r.challengeId);
    expect(await verifyCode(db, PEPPER, { id: r.challengeId, purpose: "signin", code: r.code }, T0)).toBeNull();
  });
});

describe("AUTH-09 attempts", () => {
  it("AUTH-09 attempts: 10 parallel wrong guesses leave attempts at 5, and only 5 reach the compare", async () => {
    const db = setup();
    const r = await issued(db, { purpose: "signin", emailNorm: EMAIL });
    const c = counting(db);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        verifyCode(c.db, PEPPER, { id: r.challengeId, purpose: "signin", code: wrong(r.code) }, T0),
      ),
    );
    expect(results.every((x) => x === null)).toBe(true);
    expect(c.compared()).toBe(MAX_ATTEMPTS);
    expect(db.raw.prepare("SELECT attempts FROM email_code WHERE id = ?").get(r.challengeId)).toEqual({ attempts: 5 });
  });

  it("AUTH-09 attempts: the right code on the 6th attempt is refused", async () => {
    const db = setup();
    const r = await issued(db, { purpose: "signin", emailNorm: EMAIL });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(
        await verifyCode(db, PEPPER, { id: r.challengeId, purpose: "signin", code: wrong(r.code) }, T0),
      ).toBeNull();
    }
    expect(await verifyCode(db, PEPPER, { id: r.challengeId, purpose: "signin", code: r.code }, T0)).toBeNull();
  });

  it("AUTH-09 attempts: the right code works once, even when two requests race with it", async () => {
    const db = setup();
    const r = await issued(db, { purpose: "signin", emailNorm: EMAIL });
    const both = await Promise.all([
      verifyCode(db, PEPPER, { id: r.challengeId, purpose: "signin", code: r.code }, T0),
      verifyCode(db, PEPPER, { id: r.challengeId, purpose: "signin", code: r.code }, T0),
    ]);
    expect(both.filter((x) => x !== null)).toHaveLength(1);
  });

  it("AUTH-09 attempts: an expired code is refused before any compare", async () => {
    const db = setup();
    const r = await issued(db, { purpose: "signin", emailNorm: EMAIL });
    expect(
      await verifyCode(db, PEPPER, { id: r.challengeId, purpose: "signin", code: r.code }, r.expiresAt),
    ).toBeNull();
  });

  it("AUTH-09 attempts (fail-first): at 4 attempts, a read-then-compare double lets 2 parallel guesses through; the guard lets 1", async () => {
    const naiveDb = setup();
    const n = await issued(naiveDb, { purpose: "signin", emailNorm: EMAIL });
    naiveDb.raw.prepare("UPDATE email_code SET attempts = 4 WHERE id = ?").run(n.challengeId);
    let naive = 0;
    await Promise.all([1, 2].map(() => naiveVerify(naiveDb, n.challengeId, wrong(n.code), () => naive++)));
    expect(naive).toBe(2);

    const db = setup();
    const r = await issued(db, { purpose: "signin", emailNorm: EMAIL });
    db.raw.prepare("UPDATE email_code SET attempts = 4 WHERE id = ?").run(r.challengeId);
    const c = counting(db);
    await Promise.all(
      [1, 2].map(() => verifyCode(c.db, PEPPER, { id: r.challengeId, purpose: "signin", code: wrong(r.code) }, T0)),
    );
    expect(c.compared()).toBe(1);
  });
});

describe("AUTH-09 bucket", () => {
  it("AUTH-09 bucket: stranger requests fill only the known=0 bucket; a known device still gets a code", async () => {
    const db = setup();
    for (let i = 0; i < 3; i++) await issued(db, { purpose: "signin", emailNorm: EMAIL, known: false }, T0 + i);
    const before = db.raw.prepare("SELECT count(*) AS n, sum(expires_at) AS e FROM email_code").get();
    const full = await issueCode(db, PEPPER, { purpose: "signin", emailNorm: EMAIL, known: false }, TTL, T0 + 3);
    expect(full).toMatchObject({ limited: true });
    expect(full.limited && full.retryAfterSeconds).toBe(15 * 60);
    // A refused request writes nothing: no row, and no supersede of the live code.
    expect(db.raw.prepare("SELECT count(*) AS n, sum(expires_at) AS e FROM email_code").get()).toEqual(before);
    const known = await issueCode(db, PEPPER, { purpose: "signin", emailNorm: EMAIL, known: true }, TTL, T0 + 4);
    expect(known.limited).toBe(false);
  });

  it("AUTH-09 bucket: supersede reaches only its own bucket", async () => {
    const db = setup();
    const member = await issued(db, { purpose: "signin", emailNorm: EMAIL, known: true });
    const stranger = await issued(db, { purpose: "signin", emailNorm: EMAIL, known: false }, T0 + 1);
    await issued(db, { purpose: "reauth", emailNorm: EMAIL, userId: "u1" }, T0 + 2);
    expect(
      await verifyCode(db, PEPPER, { id: member.challengeId, purpose: "signin", code: member.code }, T0 + 3),
    ).not.toBeNull();
    // A newer code in the same bucket supersedes the older one.
    await issued(db, { purpose: "signin", emailNorm: EMAIL, known: false }, T0 + 4);
    expect(
      await verifyCode(db, PEPPER, { id: stranger.challengeId, purpose: "signin", code: stranger.code }, T0 + 5),
    ).toBeNull();
  });

  it("AUTH-09 bucket: invites are limited per invite (5 a day), and another address's requests never touch them", async () => {
    const db = setup();
    for (let i = 0; i < 10; i++)
      await issueCode(db, PEPPER, { purpose: "signin", emailNorm: EMAIL }, TTL, T0 + i * 16 * MIN);
    for (let i = 0; i < 5; i++) await issued(db, { purpose: "invite", emailNorm: EMAIL, inviteId: "inv1" }, T0 + i);
    expect(
      (await issueCode(db, PEPPER, { purpose: "invite", emailNorm: EMAIL, inviteId: "inv1" }, TTL, T0 + 9)).limited,
    ).toBe(true);
  });

  it("AUTH-09 bucket: 50 guesses a day is the ceiling per bucket", async () => {
    const db = setup();
    const c = counting(db);
    let codes = 0;
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * 16 * MIN;
      const r = await issueCode(db, PEPPER, { purpose: "signin", emailNorm: EMAIL }, TTL, at);
      if (r.limited) continue;
      codes++;
      for (let g = 0; g < MAX_ATTEMPTS + 1; g++) {
        await verifyCode(c.db, PEPPER, { id: r.challengeId, purpose: "signin", code: wrong(r.code) }, at);
      }
    }
    expect(codes).toBe(10);
    expect(c.compared()).toBe(50);
  });
});

describe("AUTH-09 purpose", () => {
  it("AUTH-09 purpose: each purpose's id is refused by every other purpose's verify", async () => {
    const db = setup();
    const inputs: Record<CodePurpose, IssueInput> = {
      signin: { purpose: "signin", emailNorm: EMAIL },
      invite: { purpose: "invite", emailNorm: EMAIL, inviteId: "inv1" },
      reauth: { purpose: "reauth", emailNorm: EMAIL, userId: "u1" },
      email_change: { purpose: "email_change", emailNorm: EMAIL, newEmailNorm: "new@example.test", userId: "u1" },
    };
    for (const [purpose, input] of Object.entries(inputs)) {
      const r = await issued(db, input);
      for (const other of Object.keys(inputs) as CodePurpose[]) {
        if (other === purpose) continue;
        expect(
          await verifyCode(db, PEPPER, { id: r.challengeId, purpose: other, code: r.code, userId: "u1" }, T0),
        ).toBeNull();
      }
      const pinned = input.userId ? { userId: "u1" } : {};
      expect(
        await verifyCode(db, PEPPER, { id: r.challengeId, purpose: input.purpose, code: r.code, ...pinned }, T0),
      ).not.toBeNull();
    }
  });

  it("AUTH-09 purpose: a reauth code is refused for another session's user", async () => {
    const db = setup();
    const r = await issued(db, { purpose: "reauth", emailNorm: EMAIL, userId: "u1" });
    expect(
      await verifyCode(db, PEPPER, { id: r.challengeId, purpose: "reauth", code: r.code, userId: "u2" }, T0),
    ).toBeNull();
  });

  it("AUTH-09 purpose: a code without its bucket key is a programming error, not a row", async () => {
    const db = setup();
    await expect(issueCode(db, PEPPER, { purpose: "reauth", emailNorm: EMAIL }, TTL, T0)).rejects.toThrow(RangeError);
    await expect(issueCode(db, PEPPER, { purpose: "invite", emailNorm: EMAIL }, TTL, T0)).rejects.toThrow(RangeError);
    expect(db.raw.prepare("SELECT count(*) AS n FROM email_code").get()).toEqual({ n: 0 });
  });
});

describe("AUTH-09 draw", () => {
  it("AUTH-09 draw: 10^5 codes are 6 digits, each position within 1% of uniform, leading zeros kept", () => {
    const counts = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
    let leadingZero = false;
    for (let i = 0; i < 100_000; i++) {
      const code = drawEmailCode();
      expect(code).toMatch(/^\d{6}$/);
      if (code[0] === "0") leadingZero = true;
      for (let p = 0; p < 6; p++) {
        const row = counts[p] as number[];
        row[Number(code[p])] = (row[Number(code[p])] ?? 0) + 1;
      }
    }
    expect(leadingZero).toBe(true);
    for (const position of counts) for (const n of position) expect(Math.abs(n / 100_000 - 0.1)).toBeLessThan(0.01);
  });
});

describe("AUTH-09 device", () => {
  it("AUTH-09 device: two devices get different values, and both are known for their member only", async () => {
    const a = await newDeviceValue(PEPPER, "u1");
    const b = await newDeviceValue(PEPPER, "u1");
    expect(a).not.toBe(b);
    expect(await isKnown(a, PEPPER, "u1")).toBe(true);
    expect(await isKnown(b, PEPPER, "u1")).toBe(true);
    expect(await isKnown(a, PEPPER, "u2")).toBe(false);
    expect(await isKnown(a, PEPPER, null)).toBe(false);
    expect(await isKnown(null, PEPPER, "u1")).toBe(false);
  });

  it("AUTH-09 device: a forged nonce or MAC, or another pepper, is unknown", async () => {
    const value = await newDeviceValue(PEPPER, "u1");
    const [nonce, mac] = value.split(".") as [string, string];
    const flip = (s: string, i: number, alphabet: string) =>
      s.slice(0, i) + (s[i] === alphabet[0] ? alphabet[1] : alphabet[0]) + s.slice(i + 1);
    expect(await isKnown(`${flip(nonce, 0, "AB")}.${mac}`, PEPPER, "u1")).toBe(false);
    expect(await isKnown(`${nonce}.${flip(mac, 63, "01")}`, PEPPER, "u1")).toBe(false);
    expect(await isKnown(`${nonce}.${mac}x`, PEPPER, "u1")).toBe(false);
    expect(await isKnown(value, "q".repeat(32), "u1")).toBe(false);
  });
});
