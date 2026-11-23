import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../migrations", import.meta.url));

it("migrations apply in order to an empty SQLite database with foreign keys on", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files[0]).toBe("0001_init.sql");
  for (const file of files) db.exec(readFileSync(join(dir, file), "utf8"));

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  expect(tables.map((t) => t.name)).toEqual(
    expect.arrayContaining(["org", "room", "app_user", "token_grant", "phone_session", "session", "audit_event"]),
  );
});
