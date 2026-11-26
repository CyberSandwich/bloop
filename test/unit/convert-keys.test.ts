import { describe, expect, it } from "vitest";
import { bundleAllowlist, locate, notesKey, outputKey, prefixOf } from "../../src/worker/convert/keys.ts";
import { storedPaths } from "../../src/worker/convert/outputs.ts";
import { containerEnv, deadlineSeconds, PROFILES } from "../../src/worker/convert/profile.ts";
import { addGuest, world } from "./convert-world.ts";

describe("CONV-10 smuggling: keys", () => {
  const prefix = "u/u1/f1/v1";

  it("builds bundle keys under d/ and puts notes only under n/", () => {
    expect(outputKey(prefix, "slides.json")).toBe("u/u1/f1/v1/d/slides.json");
    expect(outputKey(prefix, "s/1920.pack")).toBe("u/u1/f1/v1/d/s/1920.pack");
    expect(outputKey(prefix, "s/1/480.webp")).toBe("u/u1/f1/v1/d/s/1/480.webp");
    expect(outputKey(prefix, "notes.json")).toBe("u/u1/f1/v1/n/notes.json");
    expect(notesKey(prefix)).toBe("u/u1/f1/v1/n/notes.json");
  });

  it.each([
    "../x",
    "/slides.json",
    "s/2/1920.webp",
    "meta.json",
    "d/slides.json",
    "slides.json/",
    "S/1920.pack",
    "x.html",
    "s/0.pack",
    "notes.json\n",
  ])("refuses the name %j", (rel) => {
    expect(() => outputKey(prefix, rel)).toThrow(RangeError);
  });

  it("takes the prefix from D1: a library key without its leaf, a guest key as it is", async () => {
    const w = world();
    expect(prefixOf(w.originalKey)).toBe(w.prefix);
    const found = await locate(w.db, "library", w.fileId, w.version);
    expect(found).toMatchObject({
      bucket: "LIBRARY",
      prefix: w.prefix,
      originalKey: w.originalKey,
      ext: "pptx",
      bytes: 1000,
    });
    const guestKey = addGuest(w.db, "s1");
    expect(await locate(w.db, "guest", "s1", 1)).toMatchObject({
      bucket: "GUEST_FILES",
      prefix: guestKey,
      ext: "pptx",
    });
  });

  it("the allowlist is the stored names minus notes and meta, packs included", () => {
    const files = [...storedPaths("slides", [1920, 480]), ...storedPaths("pdf", []), ...storedPaths("notes", [])].map(
      (path) => ({ path }),
    );
    const list = bundleAllowlist({ files });
    expect(list).toContain("s/1920.pack");
    expect(list).toContain("slides.json");
    expect(list).not.toContain("notes.json");
    expect(list.some((p) => p.includes("meta"))).toBe(false);
    for (const p of list) expect(() => outputKey("p", p)).not.toThrow();
  });
});

describe("locate refuses what is not servable", () => {
  it("a missing, trashed, disabled or wrong-version file, and an owner who is purging or suspended", async () => {
    const w = world();
    expect(await locate(w.db, "library", "nope", 1)).toBeNull();
    expect(await locate(w.db, "library", w.fileId, 2)).toBeNull();
    const set = (sql: string) => w.db.raw.exec(sql);
    set("UPDATE library_file SET trashed_at = 5");
    expect(await locate(w.db, "library", w.fileId, 1)).toBeNull();
    set("UPDATE library_file SET trashed_at = NULL, disabled_at = 5");
    expect(await locate(w.db, "library", w.fileId, 1)).toBeNull();
    set("UPDATE library_file SET disabled_at = NULL");
    expect(await locate(w.db, "library", w.fileId, 1)).not.toBeNull();
    set("UPDATE app_user SET status = 'purging'");
    expect(await locate(w.db, "library", w.fileId, 1)).toBeNull();
    set("UPDATE app_user SET status = 'active', suspended_at = 1");
    expect(await locate(w.db, "library", w.fileId, 1)).toBeNull();
  });

  it("a deleted guest file", async () => {
    const w = world();
    addGuest(w.db, "s1");
    w.db.raw.exec("UPDATE guest_file SET deleted_at = 3");
    expect(await locate(w.db, "guest", "s1", 1)).toBeNull();
  });
});

describe("CONV-02 caps: profiles and the deadline", () => {
  const { full, demo } = PROFILES;

  it("the demo env sets 40 pages, 200 MB and two widths; the input cap is the stored size", () => {
    expect(containerEnv(demo, 25_000_000)).toEqual({
      BLOOP_MAX_INPUT: "25000000",
      BLOOP_MAX_PAGES: "40",
      BLOOP_MAX_UNPACKED: "200000000",
      BLOOP_WIDTHS: "1920,480",
    });
    expect(containerEnv(full, 123)).toMatchObject({
      BLOOP_MAX_INPUT: "123",
      BLOOP_MAX_PAGES: "300",
      BLOOP_WIDTHS: "3840,1920,480",
    });
  });

  it("the deadline adds the second convert for ppt, pps and odp only", () => {
    const base = deadlineSeconds("deck", "pptx", 1_000_000, full);
    expect(deadlineSeconds("deck", "ppt", 1_000_000, full)).toBe(base + 180);
    expect(deadlineSeconds("deck", "pps", 1_000_000, full)).toBe(base + 180);
    expect(deadlineSeconds("deck", "odp", 1_000_000, full)).toBe(base + 180);
    expect(deadlineSeconds("doc", "docx", 1_000_000, full)).toBe(base);
  });

  it("the deadline per kind, from boot to slack", () => {
    // 90 boot + (30 + 1 chunk-second) input + stages + (120 + 0.5 x pages) store + 60 slack
    // rasterize is the container's 500 s default (container/README.md), not plan-v2's early 240
    expect(deadlineSeconds("deck", "pptx", 4 * 1024 * 1024, full)).toBe(
      90 + 31 + (30 + 180 + 30 + 500) + (120 + 150) + 60,
    );
    expect(deadlineSeconds("deck", "pptx", 4 * 1024 * 1024, demo)).toBe(90 + 31 + 740 + (120 + 20) + 60);
    expect(deadlineSeconds("video", "mov", 4 * 1024 * 1024, full)).toBe(90 + 31 + (30 + 1440) + 120 + 60);
    expect(deadlineSeconds("image", "heic", 4 * 1024 * 1024, full)).toBe(90 + 31 + (30 + 60) + 120 + 60);
  });

  it("grows with the input and never clamps: a 500 MB deck fits the lease, an absurd one does not", () => {
    expect(deadlineSeconds("deck", "pptx", 500_000_000, full)).toBeLessThanOrEqual(1800);
    expect(deadlineSeconds("deck", "ppt", 500_000_000_000, full)).toBeGreaterThan(1800);
  });
});
