import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../src/worker/", import.meta.url));
/** Columns that are unique on their own (a primary key). A cursor on any other column skips rows that tie. */
const UNIQUE = /^(id|rowid)$/;
const COMPARE = /\b(?:\w+\.)?(\w+)\s*(?:<|>)=?\s*[?:]/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}${e.name}/`) : e.name.endsWith(".ts") ? [`${dir}${e.name}`] : [],
  );
}

/** A SQL string is a keyset page when it has a LIMIT and compares its ORDER BY column with a bound parameter. */
function cursorColumns(sql: string): string[] {
  const order = /\bORDER BY\s+(?:\w+\.)?(\w+)/.exec(sql)?.[1];
  if (!order || !/\bLIMIT\b/.test(sql)) return [];
  return [...sql.matchAll(COMPARE)].map((m) => m[1] ?? "").filter((c) => c === order);
}

describe("DATA-05 cursor: a paged query cursors on a unique column", () => {
  it("flags a timestamp cursor and accepts an id cursor", () => {
    expect(cursorColumns("SELECT 1 FROM t WHERE a.at < ?2 ORDER BY a.at DESC LIMIT ?3")).toEqual(["at"]);
    expect(cursorColumns("SELECT 1 FROM t WHERE a.id < ?2 ORDER BY a.id DESC LIMIT ?3")).toEqual(["id"]);
    expect(cursorColumns("SELECT 1 FROM t WHERE at < ?2")).toEqual([]);
  });

  it("no Worker query pages on a column that can tie", () => {
    const bad: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const literal of text.match(/`[^`]*`|"[^"\n]*"/g) ?? []) {
        for (const column of cursorColumns(literal)) {
          if (!UNIQUE.test(column)) bad.push(`${file.slice(ROOT.length)}: ${column}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
