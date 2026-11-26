// tools/invite.mjs: the owner's first-admin invite, printed as a D1 command and a link, never run.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { issueCode } from "../../src/worker/auth/codes.ts";
import { inviteHash, peekInvite } from "../../src/worker/auth/invites.ts";
import { invite } from "../../tools/invite.mjs";
import { testDb } from "./d1-shim.ts";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const TOOL = fileURLToPath(new URL("../../tools/invite.mjs", import.meta.url));
const NOW = 1_800_000_000_000;
const TOKEN = "T".repeat(43);

/** The SQL inside the printed `--command "..."`. */
const sqlOf = (command: string) => /--command "(.*)"$/.exec(command)?.[1] ?? "";

describe("tools/invite.mjs", () => {
  it("prints the remote command and the PUBLIC_ORIGIN link; --local names npm run dev's D1 and origin", async () => {
    const remote = await invite("Owner@Example.test", { now: NOW, token: TOKEN });
    expect(remote.command).toMatch(
      /^npx wrangler d1 execute bloop --remote --command "UPDATE email_code .*; INSERT INTO invite /,
    );
    expect(remote.link).toBe(`https://bloop.here/invite#t=${TOKEN}`);
    const local = await invite("owner@example.test", { local: true, now: NOW, token: TOKEN });
    expect(local.command).toMatch(/^npx wrangler d1 execute bloop --local --persist-to \.wrangler\/state --command /);
    expect(local.link).toBe(`http://localhost:8787/invite#t=${TOKEN}`);
  });

  it("INV-01 hash: the command holds the token's SHA-256, never the token, and expires after INVITE_TTL_DAYS", async () => {
    const { command } = await invite("owner@example.test", { now: NOW, token: TOKEN });
    expect(command).toContain(`'${await inviteHash(TOKEN)}'`);
    expect(command).not.toContain(TOKEN);
    expect(command).toContain(`, ${NOW + 7 * 86_400_000}, `);
  });

  it("the SQL runs as printed: it writes an open invite for the normalized address, and a second run reissues it", async () => {
    const db = testDb();
    db.raw.exec(sqlOf((await invite(" Owner@Example.TEST ", { now: NOW, token: TOKEN, id: "i1" })).command));
    const first = await peekInvite(db, await inviteHash(TOKEN), NOW);
    expect(first).toMatchObject({ state: "open", row: { id: "i1", emailNorm: "owner@example.test" } });
    const other = "U".repeat(43);
    db.raw.exec(sqlOf((await invite("owner@example.test", { now: NOW, token: other, id: "i2" })).command));
    expect((await peekInvite(db, await inviteHash(TOKEN), NOW)).state).toBe("invalid");
    expect((await peekInvite(db, await inviteHash(other), NOW)).row?.id).toBe("i1");
  });

  it("INV-05 resend: a second run kills the codes already sent for the first link", async () => {
    const db = testDb();
    const now = Date.now();
    db.raw.exec(sqlOf((await invite("owner@example.test", { now, token: TOKEN, id: "i1" })).command));
    const sent = await issueCode(
      db,
      "C".repeat(43),
      { purpose: "invite", emailNorm: "owner@example.test", inviteId: "i1" },
      600,
    );
    if (sent.limited) throw new Error("limited");
    const live = () =>
      db.raw.prepare("SELECT count(*) AS n FROM email_code WHERE expires_at > ?").get(Date.now() + 1) as { n: number };
    expect(live()).toEqual({ n: 1 });
    db.raw.exec(sqlOf((await invite("owner@example.test", { now: Date.now(), token: "U".repeat(43) })).command));
    expect(live()).toEqual({ n: 0 });
  });

  it("a quote in the address is doubled in the SQL, and what the shell would expand is refused", async () => {
    const db = testDb();
    const { command } = await invite("o'brien@example.test", { now: NOW, token: TOKEN });
    expect(command).toContain("'o''brien@example.test'");
    db.raw.exec(sqlOf(command));
    expect(db.raw.prepare("SELECT email_norm FROM invite").all()).toEqual([{ email_norm: "o'brien@example.test" }]);
    for (const bad of ['a"b@example.test', "a$b@example.test", "a`b@example.test", "a\\b@example.test", "a!b@x.io"])
      await expect(invite(bad), bad).rejects.toThrow(/shell command/);
    await expect(invite("not an address")).rejects.toThrow(/not an address/);
  });

  it("the CLI prints the two lines, and refuses a missing address with its usage", { timeout: SPAWN_TIMEOUT }, () => {
    const ok = spawnSync(process.execPath, [TOOL, "owner@example.test"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    const lines = ok.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^https:\/\/bloop\.here\/invite#t=[A-Za-z0-9_-]{43}$/);
    const none = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
    expect([none.status, none.stderr.trim()]).toEqual([64, "usage: node tools/invite.mjs <email> [--local]"]);
  });
});
