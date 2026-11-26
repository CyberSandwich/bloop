import { describe, expect, it } from "vitest";
import type { SourceContext } from "../../src/worker/seams/file-source/index.ts";
import { LibraryFileSource } from "../../src/worker/seams/file-source/library.ts";
import { addFile, libWith } from "./library-db.ts";
import { fakeBucket } from "./library-r2.ts";

const NOW = 1_000;
const UNSET = Symbol("pinned left out");
const ctxFor = (
  userId: string | null,
  pinned: SourceContext["pinned"] | typeof UNSET = { publicId: "pub1", now: NOW },
) =>
  ({
    mode: "account",
    userId,
    folderId: null,
    accessToken: async () => ({ ok: false, error: "auth_required" }),
    ...(pinned === UNSET ? {} : { pinned }),
  }) as unknown as SourceContext;

function setup() {
  const db = libWith(["u1", "u2"]);
  db.raw
    .prepare(
      "INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('h', 'u1', 0, 0, 5000, 'pub1')",
    )
    .run();
  const lib = fakeBucket({ "u/u1/a/v1/orig": "x".repeat(100), "u/u1/p/v1/orig": "y".repeat(100) });
  const source = new LibraryFileSource({ DB: db, LIBRARY: lib.bucket });
  return { db, lib, source };
}

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

describe("library FileSource", () => {
  it("lists the owner's servable files, Up Next first, with their updated time as the edit time", async () => {
    const { db, source } = setup();
    addFile(db, { id: "a", updatedAt: 10 });
    addFile(db, { id: "b", updatedAt: 20 });
    addFile(db, { id: "c", updatedAt: 5, selectedAt: 1 });
    const out = await source.listRecent(ctxFor("u1"), 10);
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.files.map((f) => f.id)).toEqual(["c", "b", "a"]);
    expect(out.files[1]).toMatchObject({ kind: "file", name: "b.pptx", type: "pptx", modifiedAt: 20, size: 100 });
  });

  it("serves nothing that is trashed, disabled, not ready, or another user's", async () => {
    const { db, source } = setup();
    addFile(db, { id: "t", trashedAt: 5 });
    addFile(db, { id: "d", disabledAt: 5 });
    addFile(db, { id: "s", status: "scanning" });
    addFile(db, { id: "o", user: "u2" });
    for (const id of ["t", "d", "s", "o"]) {
      expect(await source.resolve(ctxFor("u1"), id)).toEqual({ ok: false, error: "file_not_found" });
    }
    expect(await source.listRecent(ctxFor("u1"), 10)).toEqual({ ok: false, error: "no_files" });
  });

  it("refuses a suspended owner", async () => {
    const { db, source } = setup();
    addFile(db, { id: "a" });
    db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 'u1'").run();
    expect(await source.resolve(ctxFor("u1"), "a")).toEqual({ ok: false, error: "file_not_found" });
  });

  it("fails closed with no user, and with no pinned decision at all", async () => {
    const { db, source } = setup();
    addFile(db, { id: "a" });
    expect(await source.resolve(ctxFor(null), "a")).toEqual({ ok: false, error: "auth_required" });
    expect(await source.resolve(ctxFor("u1", UNSET), "a")).toEqual({ ok: false, error: "auth_required" });
    expect(await source.listRecent(ctxFor("u1", UNSET), 5)).toEqual({ ok: false, error: "auth_required" });
  });

  it("a screen's fetch needs the phone session alive; an expired or foreign one finds nothing, and null (a /p/ fetch) skips it", async () => {
    const { db, source } = setup();
    addFile(db, { id: "a" });
    expect(await source.resolve(ctxFor("u1", { publicId: "pub1", now: NOW }), "a")).toMatchObject({ ok: true });
    expect(await source.resolve(ctxFor("u1", { publicId: "pub1", now: 9_999 }), "a")).toEqual({
      ok: false,
      error: "file_not_found",
    });
    expect(await source.resolve(ctxFor("u1", { publicId: "nope", now: NOW }), "a")).toEqual({
      ok: false,
      error: "file_not_found",
    });
    expect(await source.resolve(ctxFor("u1", null), "a")).toMatchObject({ ok: true });
  });

  it("streams the object whole or by range, and reports a missing or resized object as not found", async () => {
    const { db, lib, source } = setup();
    addFile(db, { id: "a" });
    const got = await source.resolve(ctxFor("u1"), "a");
    if (!got.ok) throw new Error("not resolved");
    expect(got.file).toMatchObject({ name: "a.pptx", type: "pptx", size: 100, url: null });
    const whole = await got.file.body();
    expect(whole.ok && whole.length).toBe(100);
    const part = await got.file.body({ offset: 10, length: 5 });
    if (!part.ok) throw new Error("no range");
    expect(part.length).toBe(5);
    expect(await text(part.stream)).toBe("xxxxx");
    lib.objects.set("u/u1/a/v1/orig", new Uint8Array(3));
    expect(await got.file.body()).toEqual({ ok: false, error: "file_not_found" });
    lib.objects.delete("u/u1/a/v1/orig");
    expect(await got.file.body()).toEqual({ ok: false, error: "file_not_found" });
  });

  it("a PDF is its own rendition, and another type has none", async () => {
    const { db, source } = setup();
    addFile(db, { id: "a" });
    addFile(db, { id: "p", ext: "pdf", name: "p.pdf" });
    expect(await source.resolvePdf(ctxFor("u1"), "a")).toEqual({ ok: false, error: "pdf_unavailable" });
    expect(await source.resolvePdf(ctxFor("u1"), "p")).toMatchObject({ ok: true });
    expect(await source.resolvePdf(ctxFor("u1"), "zzz")).toEqual({ ok: false, error: "file_not_found" });
  });

  it("a type the screen cannot show is refused on a fetch and left out of the list", async () => {
    const { db, source } = setup();
    addFile(db, { id: "w", ext: "docx", name: "w.docx" });
    addFile(db, { id: "a" });
    expect(await source.resolve(ctxFor("u1"), "w")).toEqual({ ok: false, error: "file_type_refused" });
    const out = await source.listRecent(ctxFor("u1"), 10);
    expect(out.ok && out.files.map((f) => f.id)).toEqual(["a"]);
  });
});
