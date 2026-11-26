// The Screen object's thin lookups (seams/open-path/lookups.ts): who the pairing is pinned to, the approve pin, and
// where an item's notes live. Pure, over the stored machine.
import { describe, expect, it } from "vitest";
import type { Machine } from "../../src/worker/machine.ts";
import { cookieMismatch, notesTarget, pinnedUser } from "../../src/worker/seams/open-path/lookups.ts";
import { asItem, DECK, must, sec, T0, waiting } from "./machine-helpers.ts";

const FILE_ID = "Fq7Zr2Kd9Lm4Np6Tx8Vb1W";
const REF = `${FILE_ID}:3`;

function signedIn(userId: string | null, phoneSession: string | null = "ps-A"): Machine {
  const claimed = must(waiting("live"), {
    e: "claim",
    now: T0 + sec(1),
    code: "AAAAAA",
    sessionId: "s1",
    secretHash: "hash",
    match: "42",
    kind: "owner",
    userId,
    phoneSession,
    passHash: null,
    choices: ["17", "42", "85"],
  }).next;
  return must(claimed, { e: "match", now: T0 + sec(2), choice: "42" }).next;
}

function withNotes(notes: boolean, source: "library" | "mock" = "library"): Machine {
  const item = asItem(source === "library" ? { source, ref: REF, name: "Talk.pptx", type: "pptx" } : DECK);
  const listed = must(signedIn("user-A"), { e: "listed", now: T0 + sec(2), ids: [item.ref] }).next;
  const approved = must(listed, { e: "approve", now: T0 + sec(3), items: [item], minutes: 60 }).next;
  return must(approved, {
    e: "derivedReady",
    now: T0 + sec(4),
    ref: item.ref,
    derived: { slides: true, pdf: false, pages: 3, motion: false },
    extra: { notes, fontsMissing: [] },
  }).next;
}

describe("ADR 0015 pin: the claim's user is final", () => {
  it("ADR 0015 pin: claim as A, then a cookie for B (or none) is refused at approve; A passes", () => {
    const m = signedIn("user-A");
    expect(cookieMismatch(m, "user-B")).toBe(true);
    expect(cookieMismatch(m, null)).toBe(true);
    expect(cookieMismatch(m, "user-A")).toBe(false);
    // A signed-out claim pins nobody: signing in afterwards cannot adopt the pairing.
    expect(cookieMismatch(signedIn(null), "user-B")).toBe(true);
    expect(cookieMismatch(signedIn(null), null)).toBe(false);
    // No pairing: nothing to approve onto.
    expect(cookieMismatch(waiting("live"), null)).toBe(true);
  });

  it("pinnedUser answers the user and the sign-in, and the end drops both", () => {
    expect(pinnedUser(signedIn("user-A"))).toEqual({ userId: "user-A", sessionPublicId: "ps-A" });
    // A sign-in id without a user is never kept.
    expect(pinnedUser(signedIn(null, "ps-A"))).toEqual({ userId: null, sessionPublicId: null });
    expect(pinnedUser(waiting("live"))).toBeNull();
    expect(pinnedUser(null)).toBeNull();
    const ended = must(signedIn("user-A"), { e: "cancel", now: T0 + sec(5) }).next;
    expect(pinnedUser(ended)).toBeNull();
  });
});

describe("NOTES-01 notesTarget", () => {
  it("NOTES-01 phone-only: the version's prefix under the pinned user, for a library item with notes", () => {
    expect(notesTarget(withNotes(true), "i1")).toEqual({
      bucket: "LIBRARY",
      prefix: `u/user-A/${FILE_ID}/v3`,
      userId: "user-A",
    });
  });

  it("NOTES-01 phone-only: any miss is null: no notes, another item, a non-library file, before approval, ended", () => {
    expect(notesTarget(withNotes(false), "i1")).toBeNull();
    expect(notesTarget(withNotes(true), "i2")).toBeNull();
    expect(notesTarget(withNotes(true), "__proto__")).toBeNull();
    expect(notesTarget(withNotes(true, "mock"), "i1")).toBeNull();
    expect(notesTarget(signedIn("user-A"), "i1")).toBeNull();
    expect(notesTarget(must(withNotes(true), { e: "end", now: T0 + sec(9), by: "phone" }).next, "i1")).toBeNull();
    expect(notesTarget(null, "i1")).toBeNull();
  });
});
