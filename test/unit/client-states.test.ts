import { describe, expect, it } from "vitest";
import { type PhoneCtx, phoneKey, type ScreenCtx, screenKey } from "../../public/js/core/states.js";
import type { FileEntry, PhoneView, ScreenView, SessionState } from "../../src/shared/protocol.ts";

const screenView = (state: SessionState, over: Partial<ScreenView> = {}): ScreenView => ({
  state,
  mode: "live",
  kind: null,
  room: { name: "Room 2.14", registered: true },
  code: null,
  match: null,
  fileName: null,
  openMode: null,
  endsAt: null,
  endReason: null,
  now: 0,
  ...over,
});

const phoneView = (state: SessionState, over: Partial<PhoneView> = {}): PhoneView => ({
  state,
  mode: "live",
  kind: "owner",
  room: { name: "Room 2.14", registered: true },
  match: "42",
  fileName: null,
  openMode: null,
  endsAt: null,
  endReason: null,
  now: 0,
  ...over,
});

const file = (id: string): FileEntry => ({ id, name: `${id}.pptx`, type: "pptx", modifiedAt: 0, size: null });

describe("screen state to view mapping", () => {
  const ctx = (state: SessionState, over: Partial<ScreenView> = {}, c: Partial<ScreenCtx> = {}): ScreenCtx => ({
    view: screenView(state, over),
    link: "ok",
    errored: false,
    ...c,
  });

  it.each([
    ["waiting", "waiting"],
    ["claimed", "scanned"],
    ["choosing", "choosing"],
    ["uploading", "choosing"],
    ["offered", "guest_open"],
    ["approved", "approved"],
    ["opening", "opening"],
    ["open", "open"],
    ["ended", "ended"],
    ["closed", "service_down"],
  ] as const)("a %s session shows %s", (state, key) => {
    expect(screenKey(ctx(state))).toBe(key);
  });

  it("an open mode of download or pdf shows the fallback", () => {
    expect(screenKey(ctx("open", { openMode: "download" }))).toBe("open_fallback");
    expect(screenKey(ctx("opening", { openMode: "pdf" }))).toBe("pdf_fallback");
    expect(screenKey(ctx("open", { openMode: "protocol" }))).toBe("open");
  });

  it("the link state wins over the session, and an error over a good link", () => {
    expect(screenKey(ctx("open", {}, { link: "offline" }))).toBe("offline");
    expect(screenKey(ctx("open", {}, { link: "down" }))).toBe("service_down");
    expect(screenKey(ctx("open", {}, { errored: true }))).toBe("error");
    expect(screenKey(ctx("open", {}, { link: "offline", errored: true }))).toBe("offline");
  });

  it("no view yet reads as offline, so the screen never shows a blank state as a fact", () => {
    expect(screenKey({ view: null, link: "ok", errored: false })).toBe("offline");
  });
});

describe("phone state to view mapping", () => {
  const base: PhoneCtx = {
    error: null,
    info: { roomName: "Room 2.14", registered: true, match: "42", mode: "live" },
    view: phoneView("claimed"),
    files: null,
    selected: null,
    approving: false,
    canceled: false,
  };
  const ctx = (over: Partial<PhoneCtx>): PhoneCtx => ({ ...base, ...over });

  it("is checking until the claim answers", () => {
    expect(phoneKey(ctx({ info: null, view: null }))).toBe("checking");
  });

  it("shows the match while the list loads, then approve with the first file selected", () => {
    expect(phoneKey(ctx({}))).toBe("match");
    expect(phoneKey(ctx({ files: [file("a")], selected: "a" }))).toBe("approve");
  });

  it("choose is the state of a loaded list with nothing selected", () => {
    expect(phoneKey(ctx({ files: [file("a")], selected: null }))).toBe("choose");
  });

  it("an empty list is the empty state", () => {
    expect(phoneKey(ctx({ files: [] }))).toBe("empty");
  });

  it("demo and unregistered rooms change the approve state", () => {
    const files = [file("a")];
    const info = { roomName: "Room 2.14", registered: true, match: "42", mode: "live" } as const;
    expect(phoneKey(ctx({ files, selected: "a", info: { ...info, mode: "demo", registered: false } }))).toBe(
      "approve_demo",
    );
    expect(phoneKey(ctx({ files, selected: "a", info: { ...info, registered: false } }))).toBe("unregistered");
  });

  it("approving shows while the call is in flight", () => {
    expect(phoneKey(ctx({ files: [file("a")], selected: "a", approving: true }))).toBe("approving");
  });

  it.each([
    ["approved", null, "opening"],
    ["opening", null, "opening"],
    ["open", "protocol", "open"],
    ["open", "download", "open_fallback"],
    ["open", "pdf", "pdf_fallback"],
  ] as const)("a %s session with open mode %s shows %s", (state, openMode, key) => {
    expect(phoneKey(ctx({ view: phoneView(state, { openMode }) }))).toBe(key);
  });

  it("an ended session is ended, or canceled when it was canceled", () => {
    expect(phoneKey(ctx({ view: phoneView("ended", { endReason: "phone" }) }))).toBe("ended");
    expect(phoneKey(ctx({ view: phoneView("ended", { endReason: "auto" }) }))).toBe("ended");
    expect(phoneKey(ctx({ view: phoneView("ended", { endReason: "canceled" }) }))).toBe("canceled");
    expect(phoneKey(ctx({ canceled: true, view: null }))).toBe("canceled");
  });

  it("a pairing that fell back to waiting is expired", () => {
    expect(phoneKey(ctx({ view: phoneView("waiting") }))).toBe("expired");
  });

  it("an error replaces the flow", () => {
    expect(phoneKey(ctx({ error: "taken", files: [file("a")], selected: "a" }))).toBe("taken");
    expect(phoneKey(ctx({ error: "taken", info: null, view: null }))).toBe("taken");
  });
});
