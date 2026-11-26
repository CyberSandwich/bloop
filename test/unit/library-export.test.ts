import { describe, expect, it } from "vitest";
import { crc32 } from "../../src/worker/crc32.ts";
import { BEAT_MS, buildExport, exportFilename, exportStream, takeSnapshot } from "../../src/worker/library/export.ts";
import { addFile, type LibTestDb, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const KEY = "k".repeat(32);
const enc = new TextEncoder();

/** A settled file: its bytes in the bucket, its row's size and CRC to match. */
function settled(db: LibTestDb, objects: Record<string, string>, id: string, over: Record<string, unknown> = {}) {
  const content = `content of ${id}`;
  const user = (over.user as string | undefined) ?? "u1";
  addFile(db, { id, bytes: content.length, user, ...over });
  db.raw.prepare("UPDATE library_file SET crc32 = ? WHERE id = ?").run(crc32(enc.encode(content)), id);
  objects[`u/${user}/${id}/v1/orig`] = content;
}

const snapshotOf = (db: LibTestDb, audit: { at: number; record: unknown }[] = []) =>
  takeSnapshot(db, "u1", audit, 1000);

const bytesOf = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

async function render(db: LibTestDb, objects: Record<string, string>, audit: { at: number; record: unknown }[] = []) {
  const built = await buildExport(await snapshotOf(db, audit), KEY);
  const bucket = fakeBucket(objects);
  const bytes = await bytesOf(
    exportStream(built.archive, 0, built.archive.length - 1, { userId: "u1", bucket: bucket.bucket }, async () => {}),
  );
  return { ...built, bytes, bucket };
}

/** The entries of `built.archive` with their bytes, read from the segment table (not from the zip, which another test reads). */
function entryBytes(built: Awaited<ReturnType<typeof render>>, name: string): Uint8Array | undefined {
  let offset = 0;
  for (const e of built.archive.entries) {
    const start = offset + 30 + enc.encode(e.name).length;
    if (e.name === name) return built.bytes.subarray(start, start + e.size);
    offset = start + e.size;
  }
  return undefined;
}

describe("LIB-07 export snapshot", () => {
  it("orders README, Files by id, Trash by id, data.json; lists a disabled file without its bytes", async () => {
    const db = libWith();
    const objects: Record<string, string> = {};
    settled(db, objects, "b", { name: "Talk.pptx" });
    settled(db, objects, "a", { name: "Alpha.pdf", ext: "pdf" });
    settled(db, objects, "t", { name: "Old.pptx", trashedAt: 5, purgeAfter: 99 });
    settled(db, objects, "d", { name: "Bad.pptx", disabledAt: 7 });
    addFile(db, { id: "c", status: "checking" });
    const built = await render(db, objects);
    expect(built.archive.entries.map((e) => e.name)).toEqual([
      "README.txt",
      "Files/Alpha.pdf",
      "Files/Talk.pptx",
      "Trash/Old.pptx",
      "data.json",
    ]);
    const data = JSON.parse(new TextDecoder().decode(entryBytes(built, "data.json")));
    expect(Object.keys(data)).toEqual([
      "format",
      "version",
      "snapshotAt",
      "account",
      "sessions",
      "passkeys",
      "files",
      "audit",
    ]);
    const byId = Object.fromEntries(data.files.map((f: { id: string }) => [f.id, f]));
    expect(byId.d).toMatchObject({ path: null, disabled: true });
    expect(byId.c.path).toBeNull();
    expect(byId.t).toMatchObject({ path: "Trash/Old.pptx", trashedAt: 5, purgeAfter: 99 });
    expect(Object.keys(byId.a)).toEqual([
      "id",
      "path",
      "name",
      "ext",
      "bytes",
      "sha256",
      "crc32",
      "version",
      "status",
      "createdAt",
      "updatedAt",
      "lastPresentedAt",
      "upNextPosition",
      "trashedAt",
      "purgeAfter",
      "disabled",
      "derived",
    ]);
    expect(new TextDecoder().decode(entryBytes(built, "README.txt"))).toContain("1 file was disabled");
  });

  it("the bytes streamed are the entries laid out, each file exactly once", async () => {
    const db = libWith();
    const objects: Record<string, string> = {};
    settled(db, objects, "a");
    settled(db, objects, "b");
    const built = await render(db, objects);
    expect(built.bytes.length).toBe(built.archive.length);
    expect(new TextDecoder().decode(entryBytes(built, "Files/a.pptx"))).toBe("content of a");
    expect(built.bucket.reads.sort()).toEqual(["u/u1/a/v1/orig", "u/u1/b/v1/orig"]);
  });

  it("LIB-01: another user's files, sessions and passkeys never appear", async () => {
    const db = libWith(["u1", "u2"]);
    const objects: Record<string, string> = {};
    settled(db, objects, "mine");
    settled(db, objects, "theirs", { user: "u2", name: "Secret.pptx" });
    db.raw
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('x', 'u2', 1, 1, 9, 'p2')",
      )
      .run();
    const built = await render(db, objects);
    const all = new TextDecoder().decode(built.bytes);
    expect(all).not.toContain("Secret");
    expect(all).not.toContain("theirs");
    expect(built.bucket.reads).toEqual(["u/u1/mine/v1/orig"]);
  });

  it("names no id_hash, token or key of a session or passkey", async () => {
    const db = libWith();
    db.raw
      .prepare(
        "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id, label, method) VALUES ('SECRETHASH', 'u1', 1, 2, 9, 'PUBLICID', 'Safari on iPhone', 'passkey')",
      )
      .run();
    db.raw
      .prepare(
        "INSERT INTO passkey (id, user_id, public_key, sign_count, backed_up, name, created_at) VALUES ('CREDID', 'u1', x'deadbeef', 3, 1, 'Phone', 4)",
      )
      .run();
    const built = await render(db, {});
    const data = new TextDecoder().decode(entryBytes(built, "data.json"));
    expect(data).not.toMatch(/SECRETHASH|PUBLICID|CREDID|deadbeef|sign_count/i);
    expect(JSON.parse(data)).toMatchObject({
      sessions: [{ label: "Safari on iPhone", method: "passkey", createdAt: 1, lastSeenAt: 2 }],
      passkeys: [{ name: "Phone", createdAt: 4, lastUsedAt: null, backedUp: true }],
    });
  });

  it("LIB-07 crc: a settled file without a CRC fails the export rather than writing a wrong entry", async () => {
    const db = libWith();
    addFile(db, { id: "a" });
    db.raw.prepare("UPDATE library_file SET crc32 = NULL WHERE id = 'a'").run();
    await expect(buildExport(await snapshotOf(db), KEY)).rejects.toThrow("no crc");
  });

  it("LIB-07 deterministic: the same library gives the same bytes, and the time is the newest change, not the clock", async () => {
    const db = libWith();
    const objects: Record<string, string> = {};
    settled(db, objects, "a", { updatedAt: 5000 });
    const audit = [{ at: 9000, record: { type: "library.export" } }];
    const one = await render(db, objects, audit);
    const two = await render(db, objects, audit);
    expect(two.bytes).toEqual(one.bytes);
    expect(two.etag).toBe(one.etag);
    expect(one.snapshotAt).toBe(9000);
    expect((await render(db, objects)).snapshotAt).toBe(5000);
  });

  it("the ETag changes with a name, a size or a CRC, and depends on the key", async () => {
    const db = libWith();
    const objects: Record<string, string> = {};
    settled(db, objects, "a");
    const first = (await render(db, objects)).etag;
    expect(first).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await buildExport(await snapshotOf(db), "other-key".repeat(4))).etag).not.toBe(first);
    db.raw.prepare("UPDATE library_file SET name = 'Renamed.pptx', updated_at = 77 WHERE id = 'a'").run();
    expect((await render(db, objects)).etag).not.toBe(first);
  });

  it("quota is the account's override, else the default, and Up Next positions follow tick order", async () => {
    const db = libWith();
    const objects: Record<string, string> = {};
    settled(db, objects, "a", { selectedAt: 20 });
    settled(db, objects, "b", { selectedAt: 10 });
    const built = await render(db, objects);
    const data = JSON.parse(new TextDecoder().decode(entryBytes(built, "data.json")));
    expect(data.account.quotaBytes).toBe(1000);
    expect(
      Object.fromEntries(data.files.map((f: { id: string; upNextPosition: number }) => [f.id, f.upNextPosition])),
    ).toEqual({ a: 2, b: 1 });
    db.raw.prepare("UPDATE app_user SET quota_bytes = 5 WHERE id = 'u1'").run();
    const again = await render(db, objects);
    expect(JSON.parse(new TextDecoder().decode(entryBytes(again, "data.json"))).account.quotaBytes).toBe(5);
  });

  it("names the download by the day", () => {
    expect(exportFilename(Date.UTC(2026, 10, 26, 23, 59))).toBe("bloop-export-2026-11-26.zip");
  });
});

describe("LIB-07 export stream", () => {
  async function ready() {
    const db = libWith();
    const objects: Record<string, string> = {};
    settled(db, objects, "a");
    settled(db, objects, "b");
    const built = await buildExport(await snapshotOf(db), KEY);
    return { built, objects };
  }
  const from = (
    built: Awaited<ReturnType<typeof ready>>["built"],
    objects: Record<string, string>,
    start: number,
    end: number,
    done = async () => {},
  ) => exportStream(built.archive, start, end, { userId: "u1", bucket: fakeBucket(objects).bucket }, done);

  it("a Range from every segment boundary, plus or minus 1, joins to the whole", async () => {
    const { built, objects } = await ready();
    const whole = await bytesOf(from(built, objects, 0, built.archive.length - 1));
    const cuts = new Set<number>();
    for (const s of built.archive.segments)
      for (const d of [-1, 0, 1]) cuts.add(Math.min(Math.max(s.start + d, 0), built.archive.length - 1));
    for (const a of cuts)
      expect(await bytesOf(from(built, objects, a, built.archive.length - 1))).toEqual(whole.subarray(a));
    expect(await bytesOf(from(built, objects, 40, 90))).toEqual(whole.subarray(40, 91));
  });

  it("a ranged read asks the bucket for the part, a whole entry asks for the whole object", async () => {
    const { built, objects } = await ready();
    const seen: unknown[] = [];
    const bucket = fakeBucket(objects);
    const get = bucket.bucket.get;
    bucket.bucket.get = async (key, options) => (seen.push(options ?? null), get(key, options));
    const entry = built.archive.segments.find((s) => "key" in s.source);
    if (!entry) throw new Error("no object segment");
    await bytesOf(
      exportStream(
        built.archive,
        entry.start + 3,
        entry.start + 6,
        { userId: "u1", bucket: bucket.bucket },
        async () => {},
      ),
    );
    expect(seen).toEqual([{ range: { offset: 3, length: 4 } }]);
    seen.length = 0;
    await bytesOf(
      exportStream(
        built.archive,
        entry.start,
        entry.start + entry.length - 1,
        { userId: "u1", bucket: bucket.bucket },
        async () => {},
      ),
    );
    expect(seen).toEqual([null]);
  });

  it("a missing or resized object is a stream error, never a skipped entry, and the end call runs once", async () => {
    const { built, objects } = await ready();
    for (const damage of [
      (o: Record<string, string>) => delete o["u/u1/a/v1/orig"],
      (o: Record<string, string>) => (o["u/u1/a/v1/orig"] = "shorter"),
      (o: Record<string, string>) => (o["u/u1/a/v1/orig"] = "much longer than the entry says it is"),
    ]) {
      const broken = { ...objects };
      damage(broken);
      let ended = 0;
      await expect(
        bytesOf(from(built, broken, 0, built.archive.length - 1, async () => void ended++)),
      ).rejects.toThrow();
      expect(ended).toBe(1);
    }
  });

  it("LIB-01: an entry whose key is outside the user's prefix is refused before any read", async () => {
    const { built, objects } = await ready();
    const archive = {
      ...built.archive,
      segments: built.archive.segments.map((s) =>
        "key" in s.source ? { ...s, source: { key: `u/u2/${s.source.key.slice(5)}` } } : s,
      ),
    };
    const bucket = fakeBucket({ ...objects, "u/u2/a/v1/orig": "stolen" });
    await expect(
      bytesOf(exportStream(archive, 0, archive.length - 1, { userId: "u1", bucket: bucket.bucket }, async () => {})),
    ).rejects.toThrow("prefix");
    expect(bucket.reads).toEqual([]);
  });

  it("renews the lease once a minute while it is read, and not at all when nobody reads", async () => {
    const { built, objects } = await ready();
    let clock = 0;
    let beats = 0;
    const stream = exportStream(
      built.archive,
      0,
      built.archive.length - 1,
      { userId: "u1", bucket: fakeBucket(objects).bucket, now: () => clock },
      async () => {},
      async () => void beats++,
    );
    const reader = stream.getReader();
    await reader.read();
    expect(beats).toBe(0);
    clock = BEAT_MS;
    await reader.read();
    expect(beats).toBe(1);
    clock = BEAT_MS + 1000;
    await reader.read();
    expect(beats).toBe(1);
    clock = 2 * BEAT_MS;
    await reader.read();
    expect(beats).toBe(2);
    await reader.cancel();
    expect(beats).toBe(2);
  });

  it("a lease that cannot be renewed does not stop the bytes", async () => {
    const { built, objects } = await ready();
    let clock = 0;
    const stream = exportStream(
      built.archive,
      0,
      built.archive.length - 1,
      { userId: "u1", bucket: fakeBucket(objects).bucket, now: () => (clock += BEAT_MS) },
      async () => {},
      async () => {
        throw new Error("object unreachable");
      },
    );
    expect((await bytesOf(stream)).length).toBe(built.archive.length);
  });

  it("a cancelled download runs the end call once", async () => {
    const { built, objects } = await ready();
    let ended = 0;
    const stream = from(built, objects, 0, built.archive.length - 1, async () => void ended++);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await reader.cancel();
    expect(ended).toBe(1);
  });
});
