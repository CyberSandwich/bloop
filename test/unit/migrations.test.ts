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

it("0003 widens guest_file.type to images and keeps every earlier row", () => {
  const db = new DatabaseSync(":memory:");
  const apply = (file: string) => db.exec(readFileSync(join(dir, file), "utf8"));
  apply("0001_init.sql");
  apply("0002_r2_ops.sql");
  const insert = db.prepare("INSERT INTO guest_file VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("s1", "g/a", 10, "pptx", "aa", "Talk.pptx", 1, null);
  insert.run("s2", "g/b", 20, "pdf", "bb", "Notes.pdf", 2, 99);
  expect(() => insert.run("s3", "g/c", 1, "jpg", "cc", "Photo.jpg", 3, null)).toThrow();

  apply("0003_guest_file_images.sql");

  expect(db.prepare("SELECT * FROM guest_file ORDER BY session_id").all()).toEqual([
    {
      session_id: "s1",
      r2_key: "g/a",
      bytes: 10,
      type: "pptx",
      sha256: "aa",
      name: "Talk.pptx",
      created_at: 1,
      deleted_at: null,
    },
    {
      session_id: "s2",
      r2_key: "g/b",
      bytes: 20,
      type: "pdf",
      sha256: "bb",
      name: "Notes.pdf",
      created_at: 2,
      deleted_at: 99,
    },
  ]);
  for (const type of ["jpg", "png", "mp4", "mov"])
    insert.run(`i-${type}`, `g/${type}`, 1, type, "dd", `F.${type}`, 4, null);
  expect(() => insert.run("s4", "g/d", 1, "webp", "ee", "x.webp", 5, null)).toThrow();
  expect(() => insert.run("s5", "g/e", 1, "heic", "ff", "x.heic", 5, null)).toThrow();
  expect(() => insert.run("s1", "g/f", 1, "pdf", "gg", "dup.pdf", 6, null)).toThrow(); // the primary key survived
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'guest_file_new'").all()).toEqual([]);
});
