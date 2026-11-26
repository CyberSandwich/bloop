import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config.ts";
import type { Deps } from "../../src/worker/uploads/pipeline.ts";
import { sweepUploads } from "../../src/worker/uploads/sweep.ts";
import { PROD_VARS } from "../env-vars.ts";
import { addUser, testDb } from "./d1-shim.ts";
import { fakeMultipart } from "./fake-multipart.ts";
import { fakeSpend } from "./spend-helpers.ts";

const parsed = parseConfig({ ...PROD_VARS, CONVERT_MODE: "off" });
if (!parsed.ok) throw new Error(parsed.problems.join());
const base = parsed.config;

function rig(mode: string) {
  const db = testDb();
  addUser(db, "u1");
  const started: string[] = [];
  const config = { ...base, library: { ...base.library, convertMode: mode } } as Deps["config"];
  const d: Deps = {
    db,
    mp: fakeMultipart(),
    spend: fakeSpend(),
    config,
    now: () => 1_000_000_000,
    // What the real hook does to the row: a start leaves a derived row.
    afterReady: async (f) => {
      started.push(f.id);
      db.raw
        .prepare(
          "INSERT INTO derived (file_id, version, owner_kind, status, attempts, created_at, updated_at) VALUES (?, 1, 'library', 'queued', 0, 0, 0)",
        )
        .run(f.id);
    },
  };
  const file = (id: string, status: string, created: number, extra = "") =>
    db.raw
      .prepare(
        `INSERT INTO library_file (id, user_id, name, ext, bytes, version, r2_key, status, created_at, updated_at${extra ? ", trashed_at" : ""})
         VALUES (?1, 'u1', 'a.pdf', 'pdf', 10, 1, ?2, ?3, ?4, 1000${extra ? ", 5" : ""})`,
      )
      .run(id, `k/${id}`, status, created);
  return { db, d, started, file };
}

describe("the hourly sweep starts the conversion of ready files that have none", () => {
  it("is a no-op while CONVERT_MODE is off, and leaves the whole backlog for the day it turns on", async () => {
    const off = rig("off");
    off.file("a", "ready", 1);
    off.file("b", "ready", 2);
    expect(await sweepUploads(off.d, 50)).toMatchObject({ converted: 0, more: false });
    expect(off.started).toEqual([]);

    const on = rig("stub");
    on.file("a", "ready", 1);
    on.file("b", "ready", 2);
    expect(await sweepUploads(on.d, 50)).toMatchObject({ converted: 2 });
    expect(on.started).toEqual(["a", "b"]);
  });

  it("takes the backlog in bounded runs, oldest first, and a file that has its row is not started again", async () => {
    const r = rig("stub");
    for (const [id, created] of [
      ["c", 3],
      ["a", 1],
      ["b", 2],
    ] as const)
      r.file(id, "ready", created);
    expect(await sweepUploads(r.d, 2)).toMatchObject({ converted: 2, more: true });
    expect(r.started).toEqual(["a", "b"]);
    expect(await sweepUploads(r.d, 2)).toMatchObject({ converted: 1, more: false });
    expect(r.started).toEqual(["a", "b", "c"]);
    expect(await sweepUploads(r.d, 2)).toMatchObject({ converted: 0 });
  });

  it("starts only files that are ready and servable: not a checking, refused or trashed one", async () => {
    const r = rig("stub");
    r.file("checking", "checking", 1);
    r.file("refused", "refused", 2);
    r.file("trashed", "ready", 3, "trashed");
    r.file("ok", "ready", 4);
    await sweepUploads(r.d, 50);
    expect(r.started).toEqual(["ok"]);
  });

  it("goes on past a start that throws, logging the id only", async () => {
    const r = rig("stub");
    r.file("a", "ready", 1);
    r.file("b", "ready", 2);
    const hook = r.d.afterReady;
    r.d.afterReady = async (f) => {
      if (f.id === "a") throw new Error("secret detail");
      await hook?.(f);
    };
    const lines: string[] = [];
    const log = console.error;
    console.error = (line: string) => void lines.push(line);
    try {
      expect(await sweepUploads(r.d, 50)).toMatchObject({ converted: 1 });
    } finally {
      console.error = log;
    }
    expect(r.started).toEqual(["b"]);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ evt: "upload_sweep_failed", step: "convert", id: "a" }]);
  });
});
