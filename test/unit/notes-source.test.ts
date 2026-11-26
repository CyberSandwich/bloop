// The optional FileSource.notes method (NOTES-01 phone-only): the mock source's answer. The demo source itself needs the
// Worker bundler (it imports the deck as bytes), so its answer for the deck is asserted in test/integration/notes.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECK_PAGES } from "../../src/shared/demo-catalog.ts";
import type { FileSource, SourceContext } from "../../src/worker/seams/file-source/index.ts";
import { MockFileSource, type MockFixture } from "../../src/worker/seams/file-source/mock.ts";

const ctx: SourceContext = {
  mode: "demo",
  userId: null,
  folderId: null,
  accessToken: async () => ({ ok: false, error: "auth_required" }),
};
const NOTES = ["first", "", "third"];
const fixture = (id: string, notes?: string[]): MockFixture => ({
  id,
  name: `${id}.pptx`,
  type: "pptx",
  bytes: new Uint8Array([1]),
  editedMinutesAgo: 1,
  pdfId: null,
  ...(notes ? { notes } : {}),
});
const source = new MockFileSource([fixture("with", NOTES), fixture("without")]);

describe("NOTES-01 phone-only: MockFileSource.notes", () => {
  it("NOTES-01 phone-only: a fixture's notes come back per page, an empty page as an empty string", async () => {
    expect(await source.notes(ctx, "with")).toEqual({ ok: true, notes: NOTES });
  });

  it("NOTES-01 phone-only: a fixture with no notes answers an empty list", async () => {
    expect(await source.notes(ctx, "without")).toEqual({ ok: true, notes: [] });
  });

  it("NOTES-01 phone-only: an unknown file is file_not_found", async () => {
    expect(await source.notes(ctx, "nope")).toEqual({ ok: false, error: "file_not_found" });
  });

  it("NOTES-01 phone-only: the answer is a copy, so a caller cannot change the fixture", async () => {
    const res = await source.notes(ctx, "with");
    if (res.ok) res.notes.push("x");
    expect(await source.notes(ctx, "with")).toEqual({ ok: true, notes: NOTES });
  });

  it("NOTES-01 phone-only: the method is optional on the seam, so a source without notes still fits", () => {
    const bare: Pick<FileSource, "kind"> & { notes?: FileSource["notes"] } = { kind: "mock" };
    expect(bare.notes).toBeUndefined();
  });
});

describe("NOTES-01 phone-only: the demo deck's notes data", () => {
  const demo = JSON.parse(
    readFileSync(new URL("../../src/worker/seams/file-source/demo-files/demo-notes.json", import.meta.url), "utf8"),
  ) as unknown;

  it("NOTES-01 phone-only: one string per page of the deck", () => {
    expect(Array.isArray(demo)).toBe(true);
    expect(demo as unknown[]).toHaveLength(DECK_PAGES);
    for (const note of demo as unknown[]) expect(typeof note).toBe("string");
  });
});
