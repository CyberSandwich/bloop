import { describe, expect, it } from "vitest";
import { type Meta, phoneView, roomView, screenView } from "../../src/worker/views.ts";
import { approved, CFG, claimedOwner, ended, must, offered, sec, T0, waiting } from "./machine-helpers.ts";

const META: Meta = {
  screenRef: "ref",
  mode: "demo",
  roomId: null,
  roomName: null,
  screenSecretHash: "x",
  createdAt: T0,
};
const CONFIG = { origin: "https://bloop.example", machine: CFG };

describe("views", () => {
  it("shows the code and the QR URL only while waiting", () => {
    const view = screenView(META, waiting(), CONFIG, T0 + sec(5));
    expect(view.code).toEqual({ code: "AAAAAA", expiresAt: T0 + sec(60), qrUrl: "https://bloop.example/a?c=AAAAAA" });
    expect(screenView(META, claimedOwner(), CONFIG, T0 + sec(5)).code).toBeNull();
    expect(screenView(META, ended(), CONFIG, T0 + sec(25)).code).toBeNull();
  });

  it("hides a code past its hard expiry", () => {
    expect(screenView(META, waiting(), CONFIG, T0 + sec(70)).code).toBeNull();
    expect(screenView(META, waiting(), CONFIG, T0 + sec(69)).code).not.toBeNull();
  });

  it("SRC-01 screen-view carries the approved items' names, types and sizes and nothing else about files", () => {
    const view = screenView(META, approved(), CONFIG, T0 + sec(11));
    expect(Object.keys(view).sort()).toEqual(
      ["code", "endReason", "endsAt", "items", "kind", "match", "mode", "now", "openMode", "room", "state"].sort(),
    );
    expect(view.items).toEqual([{ kind: "file", name: "Deck.pptx", type: "pptx", size: null }]);
    expect(JSON.stringify(view)).not.toContain("deck-1");
  });

  it("shows the match code from claimed to open and not before or after", () => {
    expect(screenView(META, waiting(), CONFIG, T0).match).toBeNull();
    expect(screenView(META, claimedOwner(), CONFIG, T0 + sec(2)).match).toBe("42");
    expect(screenView(META, ended(), CONFIG, T0 + sec(25)).match).toBeNull();
  });

  it("names a guest offer's file before approval, with no end time yet", () => {
    const view = screenView(META, offered(), CONFIG, T0 + sec(12));
    expect(view).toMatchObject({ state: "offered", items: [{ name: "Guest.pptx" }], endsAt: null, kind: "guest" });
  });

  it("DEMO-01 carries the chosen file's size for the demo file card, and null when the source gave none", () => {
    expect(screenView(META, offered(), CONFIG, T0 + sec(12)).items[0]).toMatchObject({ size: 2048 });
    expect(screenView(META, approved(), CONFIG, T0 + sec(11)).items[0]).toMatchObject({ size: null });
    expect(screenView(META, waiting(), CONFIG, T0).items).toEqual([]);
  });

  it("keeps the end reason in waiting and ended", () => {
    expect(screenView(META, ended(), CONFIG, T0 + sec(25)).endReason).toBe("phone");
    const dropped = must(claimedOwner(), { e: "restart", now: T0 + sec(5) }).next;
    expect(screenView(META, dropped, CONFIG, T0 + sec(5)).endReason).toBe("canceled");
    expect(screenView(META, approved(), CONFIG, T0 + sec(11)).endReason).toBeNull();
  });

  it("builds the phone view from the pairing, and none without one", () => {
    expect(phoneView(META, waiting(), T0, 50)).toBeNull();
    expect(phoneView(META, approved(), T0 + sec(11), 50)).toMatchObject({
      state: "approved",
      kind: "owner",
      match: "42",
      items: [{ kind: "file", name: "Deck.pptx" }],
      endsAt: T0 + sec(10) + 90 * 60_000,
      endReason: null,
      dropMaxBytes: 50,
    });
    expect(phoneView(META, ended(), T0 + sec(25), 50)).toMatchObject({
      state: "ended",
      endReason: "phone",
      items: [],
      endsAt: null,
    });
  });

  it("PAIR-03 label: a screen is registered only with a room id", () => {
    expect(roomView(META)).toEqual({ name: "Demo Room", registered: false });
    expect(roomView({ ...META, mode: "live" })).toEqual({ name: "Unregistered screen", registered: false });
    expect(roomView({ ...META, mode: "live", roomId: "r1", roomName: "Room 2.14" })).toEqual({
      name: "Room 2.14",
      registered: true,
    });
  });
});
