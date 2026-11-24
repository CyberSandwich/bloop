import { describe, expect, it } from "vitest";
import { phoneKey, screenKey } from "../../public/js/core/states.js";
import { ERRORS } from "../../public/js/shared/errors.js";
import { IN_SESSION, PAIRING_OVER } from "../../public/js/shared/session.js";
import type { PhoneCtx, ScreenCtx } from "../../public/js/types.js";
import type { FileEntry, PhoneView, ScreenView, SessionState } from "../../src/shared/protocol.ts";

const screenView = (state: SessionState, over: Partial<ScreenView> = {}): ScreenView => ({
  state,
  mode: "live",
  kind: null,
  room: { name: "Room 2.14", registered: true },
  code: null,
  match: null,
  items: [],
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
  items: [],
  openMode: null,
  endsAt: null,
  endReason: null,
  dropMaxBytes: 50 * 1024 * 1024,
  now: 0,
  ...over,
});

const file = (id: string): FileEntry => ({
  kind: "file",
  id,
  name: `${id}.pptx`,
  type: "pptx",
  modifiedAt: 0,
  size: null,
});

describe("shared session rules", () => {
  it("IN_SESSION and PAIRING_OVER split the session states with no overlap", () => {
    expect(IN_SESSION).toEqual(["approved", "opening", "open"]);
    expect(PAIRING_OVER).toEqual(["ended", "waiting", "closed"]);
    expect(IN_SESSION.filter((s) => PAIRING_OVER.includes(s))).toEqual([]);
  });
});

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

  it("DEMO-01 a demo screen shows its in-page result from approved to open, whatever the open mode", () => {
    for (const state of ["approved", "opening", "open"] as const) {
      for (const openMode of [null, "protocol", "download", "pdf"] as const) {
        expect(screenKey(ctx(state, { mode: "demo", openMode }))).toBe("demo_open");
      }
    }
    expect(screenKey(ctx("offered", { mode: "demo" }))).toBe("guest_open");
    expect(screenKey(ctx("ended", { mode: "demo" }))).toBe("ended");
    expect(screenKey(ctx("open", { mode: "demo" }, { link: "offline" }))).toBe("offline");
  });

  it("F10 an original PDF shown as a PDF is not the PowerPoint fallback", () => {
    expect(
      screenKey(ctx("open", { openMode: "pdf", items: [{ kind: "file", name: "F.pdf", type: "pdf", size: null }] })),
    ).toBe("pdf_file");
    expect(
      screenKey(ctx("opening", { openMode: "pdf", items: [{ kind: "file", name: "F.pdf", type: "pdf", size: null }] })),
    ).toBe("pdf_file");
    expect(
      screenKey(ctx("open", { openMode: "pdf", items: [{ kind: "file", name: "F.pptx", type: "pptx", size: null }] })),
    ).toBe("pdf_fallback");
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

  it("F16 DEMO-02 a create refused with rate_limited is its own state, never service down", () => {
    // boot() leaves the link down after any refused create; the refusal says why.
    expect(screenKey({ view: null, link: "down", errored: false, limited: true })).toBe("rate_limited");
    expect(screenKey({ view: null, link: "down", errored: false, limited: false })).toBe("service_down");
  });
});

describe("phone state to view mapping", () => {
  const base: PhoneCtx = {
    error: null,
    info: { roomName: "Room 2.14", registered: true, match: "42", mode: "live" },
    view: phoneView("claimed"),
    files: null,
    selected: [],
    approving: false,
    canceled: false,
    drop: null,
  };
  const ctx = (over: Partial<PhoneCtx>): PhoneCtx => ({ ...base, ...over });

  it("is checking until the claim answers", () => {
    expect(phoneKey(ctx({ info: null, view: null }))).toBe("checking");
  });

  it("shows the match while the list loads, then approve with the first file selected", () => {
    expect(phoneKey(ctx({}))).toBe("match");
    expect(phoneKey(ctx({ files: [file("a")], selected: ["a"] }))).toBe("approve");
  });

  it("choose is the state of a loaded list with nothing ticked", () => {
    expect(phoneKey(ctx({ files: [file("a")], selected: [] }))).toBe("choose");
  });

  it("any mix can be approved: several ticks, or links alone", () => {
    const link = { kind: "link", id: "l", url: "https://www.vevox.com/", title: "Vevox" } as const;
    expect(phoneKey(ctx({ files: [file("a"), file("b"), link], selected: ["a", "l"] }))).toBe("approve");
    expect(phoneKey(ctx({ files: [link], selected: ["l"] }))).toBe("approve");
  });

  it("an empty list is the empty state", () => {
    expect(phoneKey(ctx({ files: [] }))).toBe("empty");
  });

  it("demo and unregistered rooms change the approve state", () => {
    const files = [file("a")];
    const info = { roomName: "Room 2.14", registered: true, match: "42", mode: "live" } as const;
    expect(phoneKey(ctx({ files, selected: ["a"], info: { ...info, mode: "demo", registered: false } }))).toBe(
      "approve_demo",
    );
    expect(phoneKey(ctx({ files, selected: ["a"], info: { ...info, registered: false } }))).toBe("unregistered");
  });

  it("approving shows while the call is in flight", () => {
    expect(phoneKey(ctx({ files: [file("a")], selected: ["a"], approving: true }))).toBe("approving");
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

  it("a refused drop on a screen with guest drop off reads as guest_off, not a generic error", () => {
    expect(ERRORS.drop_disabled.phone).toBe("guest_off");
    expect(phoneKey(ctx({ error: "guest_off" }))).toBe("guest_off");
  });

  it("DEMO-01 a demo phone reads open after the screen's Download or PDF link, never a fallback", () => {
    for (const openMode of [null, "protocol", "download", "pdf"] as const) {
      expect(phoneKey(ctx({ view: phoneView("open", { mode: "demo", openMode }) }))).toBe("open");
    }
  });

  it("F10 an original PDF on the phone shows pdf_file", () => {
    expect(
      phoneKey(
        ctx({
          view: phoneView("open", {
            openMode: "pdf",
            items: [{ kind: "file", name: "F.pdf", type: "pdf", size: null }],
          }),
        }),
      ),
    ).toBe("pdf_file");
    expect(
      phoneKey(
        ctx({
          view: phoneView("open", {
            openMode: "pdf",
            items: [{ kind: "file", name: "F.pptx", type: "pptx", size: null }],
          }),
        }),
      ),
    ).toBe("pdf_fallback");
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

  it("a phone that chose to send a file walks choose, confirm, sending in its own order", () => {
    for (const drop of ["choose", "confirm", "sending"] as const) {
      expect(phoneKey(ctx({ drop, files: [file("a")], selected: ["a"] }))).toBe(`guest_${drop}`);
    }
  });

  it("the server's word wins: an offer is sent, an upload is sending, a claimed guest chooses", () => {
    expect(phoneKey(ctx({ drop: "sending", view: phoneView("offered", { kind: "guest" }) }))).toBe("guest_sent");
    expect(phoneKey(ctx({ drop: null, view: phoneView("uploading", { kind: "guest" }) }))).toBe("guest_sending");
    expect(phoneKey(ctx({ drop: null, view: phoneView("claimed", { kind: "guest" }) }))).toBe("guest_choose");
    expect(phoneKey(ctx({ drop: "confirm", view: phoneView("claimed", { kind: "guest" }) }))).toBe("guest_confirm");
  });

  it("a refusal shows over the guest flow, and an opened drop shows as open", () => {
    expect(phoneKey(ctx({ drop: "choose", error: "guest_refused" }))).toBe("guest_refused");
    expect(phoneKey(ctx({ view: phoneView("open", { kind: "guest", openMode: "protocol" }) }))).toBe("open");
    expect(phoneKey(ctx({ view: phoneView("approved", { kind: "guest" }) }))).toBe("opening");
  });

  it("an error replaces the flow", () => {
    expect(phoneKey(ctx({ error: "taken", files: [file("a")], selected: ["a"] }))).toBe("taken");
    expect(phoneKey(ctx({ error: "taken", info: null, view: null }))).toBe("taken");
  });
});
