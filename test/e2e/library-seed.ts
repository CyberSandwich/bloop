// Library members for the browser specs: a seeded row with a session cookie, as test/integration/library.test.ts makes
// one, since sign-in is the accounts change's. A spec builds every member it needs, then seeds them all in ONE
// `wrangler d1 execute --file`: parallel executes against the dev server's local D1 fail with SQLITE_BUSY.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (v: string | number) => (typeof v === "string" ? `'${v.replaceAll("'", "''")}'` : v);
const insert = (table: string, row: Record<string, string | number>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(quote).join(", ")});`;

export interface Member {
  user: string;
  cookie: string;
}
/** A file row: its id suffix, its name, and any columns that differ from a ready file. */
export type FileRow = [string, string, Record<string, string | number>?];
/** A `derived` row for a file id suffix: status, and any other columns. */
export type DerivedRow = [string, string, Record<string, string | number>?];

/** Collects members and their rows; `seed()` writes them all at once. */
export function seeder(now = Date.now()) {
  const sql: string[] = [];
  return {
    /** @param used the account's used bytes (the quota bar) */
    member(files: FileRow[] = [], options: { used?: number; derived?: DerivedRow[] } = {}): Member {
      const user = `e2e-${randomUUID()}`;
      const cookie = `${user}-cookie`;
      sql.push(
        insert("app_user", {
          id: user,
          tid: "email",
          oid: user,
          email: `${user}@example.test`,
          created_at: now,
          last_seen_at: now,
          email_norm: `${user}@example.test`,
          status: "active",
          used_bytes: options.used ?? 0,
        }),
        insert("phone_session", {
          id_hash: sha(cookie),
          user_id: user,
          created_at: now,
          last_seen_at: now,
          expires_at: now + 86_400_000,
          public_id: `pub-${user}`,
        }),
        ...files.map(([id, name, over = {}], i) =>
          insert("library_file", {
            id: `${user}-${id}`,
            user_id: user,
            name,
            ext: name.split(".").pop() ?? "",
            bytes: (i + 1) * 3_000_000,
            version: 1,
            r2_key: `u/${user}/${id}/v1/orig`,
            status: "ready",
            created_at: now - i * 60_000,
            updated_at: now - i * 60_000,
            crc32: 0,
            ...over,
          }),
        ),
        ...(options.derived ?? []).map(([id, status, over = {}]) =>
          insert("derived", {
            file_id: `${user}-${id}`,
            version: 1,
            owner_kind: "library",
            status,
            created_at: now,
            updated_at: now,
            ...over,
          }),
        ),
      );
      return { user, cookie };
    },
    /** One execute for everything collected; a busy database (the dev server writing) is tried again. */
    seed(): void {
      if (sql.length === 0) return;
      const dir = mkdtempSync(join(tmpdir(), "bloop-seed-"));
      const file = join(dir, "seed.sql");
      writeFileSync(file, sql.join("\n"));
      try {
        for (let attempt = 1; ; attempt++) {
          const done = spawnSync(
            "npx",
            ["wrangler", "d1", "execute", "bloop", "--local", "--persist-to", ".wrangler/state", "--file", file],
            { encoding: "utf8" },
          );
          if (done.status === 0) return;
          const out = `${done.stdout}${done.stderr}`;
          if (attempt >= 5 || !out.includes("SQLITE_BUSY")) throw new Error(`d1 seed failed: ${out.slice(-400)}`);
          spawnSync("sleep", [String(attempt)]);
        }
      } finally {
        sql.length = 0;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** A header, not addCookies: Chrome's CDP refuses a Secure `__Host-` cookie for an http:// URL. */
export async function signedIn(context: BrowserContext, member: Member): Promise<void> {
  await context.setExtraHTTPHeaders({ Cookie: `__Host-bloop_sid=${member.cookie}` });
}
