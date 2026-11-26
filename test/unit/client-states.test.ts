import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withPick } from "../../public/js/core/copy-phone.js";
import {
  adopt,
  guestOnStage,
  hasPdf,
  leave,
  liveClaim,
  onRefusal,
  phoneKey,
  retryStep,
  screenKey,
} from "../../public/js/core/states.js";
import { ERRORS } from "../../public/js/shared/errors.js";
import { IN_SESSION, PAIRING_OVER } from "../../public/js/shared/session.js";
import type { PhoneCtx, ScreenCtx } from "../../public/js/types.js";
import type { ErrorCode, FileEntry, PhoneView, ScreenView, SessionState } from "../../src/shared/protocol.ts";

const screenView = (state: SessionState, over: Partial<ScreenView> = {}): ScreenView => ({
  state,
  mode: "live",
  kind: null,
  room: { name: "Room 2.14", registered: true },
  code: null,
  match: null,
  confirmed: false,
  items: [],
  shown: null,
  openMode: null,
  endsAt: null,
  endReason: null,
  upload: null,
  choiceBytes: 30_000_000,
  seq: 0,
  v: 0,
  now: 0,
  ...over,
});

const phoneView = (state: SessionState, over: Partial<PhoneView> = {}): PhoneView => ({
  state,
  mode: "live",
  kind: "owner",
  room: { name: "Room 2.14", registered: true },
  match: "42",
  choices: null,
  confirmed: true,
  firstShownAt: null,
  items: [],
  shown: null,
  openMode: null,
  endsAt: null,
  endReason: null,
  dropMaxBytes: 50 * 1024 * 1024,
  maxMinutes: 720,
  latestEnd: null,
  seq: 0,
  v: 0,
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

  it("REL-03 a blocked link shows network_blocked, in a session too, and offline still wins over nothing", () => {
    expect(screenKey(ctx("waiting", {}, { link: "blocked" }))).toBe("network_blocked");
    expect(screenKey(ctx("open", {}, { link: "blocked" }))).toBe("network_blocked");
    expect(screenKey(ctx("waiting", {}, { link: "offline" }))).toBe("offline");
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

  it("a guest's photo or video shows in the page on a live screen too; a guest's deck or PDF and an owner's photo keep the launch ladder", () => {
    const file = (type: "jpg" | "png" | "mp4" | "mov" | "pptx" | "pdf") => [
      { kind: "file" as const, id: "i1", name: `F.${type}`, type, size: 1 },
    ];
    for (const state of ["approved", "opening", "open"] as const) {
      for (const type of ["jpg", "png", "mp4", "mov"] as const) {
        for (const openMode of [null, "view", "download"] as const) {
          expect(screenKey(ctx(state, { kind: "guest", items: file(type), openMode })), type).toBe("demo_open");
        }
      }
    }
    expect(screenKey(ctx("open", { kind: "guest", items: file("pptx"), openMode: "protocol" }))).toBe("open");
    expect(screenKey(ctx("approved", { kind: "guest", items: file("pdf") }))).toBe("approved");
    expect(screenKey(ctx("open", { kind: "owner", items: file("jpg"), openMode: "view" }))).toBe("open");
    expect(screenKey(ctx("offered", { kind: "guest", items: file("mp4") }))).toBe("guest_open");
  });

  it("hasPdf: a PDF and an owner's deck have a PDF view; a guest's deck, photos and videos, and no file, have none", () => {
    const view = (kind: "guest" | "owner", type: "jpg" | "png" | "mp4" | "mov" | "pptx" | "pdf") =>
      ({ kind, items: [{ kind: "file", id: "i1", name: `F.${type}`, type, size: 1 }] }) as unknown as ScreenView;
    expect(hasPdf(view("owner", "pptx"))).toBe(true);
    expect(hasPdf(view("owner", "pdf"))).toBe(true);
    expect(hasPdf(view("guest", "pdf"))).toBe(true);
    expect(hasPdf(view("guest", "pptx"))).toBe(false);
    for (const type of ["jpg", "png", "mp4", "mov"] as const) {
      expect(hasPdf(view("owner", type)), type).toBe(false);
      expect(hasPdf(view("guest", type)), type).toBe(false);
    }
    expect(hasPdf(screenView("open"))).toBe(false);
    expect(hasPdf(null)).toBe(false);
  });

  it("guestOnStage, which both the state key and the screen's window routing read: a guest's photo or video only", () => {
    const view = (kind: "guest" | "owner", type: "jpg" | "png" | "mp4" | "mov" | "pptx" | "pdf") =>
      ({ kind, items: [{ kind: "file", id: "i1", name: `F.${type}`, type, size: 1 }] }) as unknown as ScreenView;
    for (const type of ["jpg", "png", "mp4", "mov"] as const)
      expect(guestOnStage(view("guest", type)), type).toBe(true);
    for (const type of ["pptx", "pdf"] as const) expect(guestOnStage(view("guest", type)), type).toBe(false);
    expect(guestOnStage(view("owner", "mp4"))).toBe(false);
    expect(guestOnStage(null)).toBe(false);
    expect(guestOnStage({ kind: "guest", items: [] } as unknown as ScreenView)).toBe(false);
  });

  it("F10 an original PDF shown as a PDF is not the PowerPoint fallback", () => {
    expect(
      screenKey(
        ctx("open", { openMode: "pdf", items: [{ kind: "file", id: "t1", name: "F.pdf", type: "pdf", size: null }] }),
      ),
    ).toBe("pdf_file");
    expect(
      screenKey(
        ctx("opening", {
          openMode: "pdf",
          items: [{ kind: "file", id: "t2", name: "F.pdf", type: "pdf", size: null }],
        }),
      ),
    ).toBe("pdf_file");
    expect(
      screenKey(
        ctx("open", { openMode: "pdf", items: [{ kind: "file", id: "t3", name: "F.pptx", type: "pptx", size: null }] }),
      ),
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
    info: { roomName: "Room 2.14", registered: true, match: "42", choices: null, mode: "live", kind: "owner" },
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
    const info = {
      roomName: "Room 2.14",
      registered: true,
      match: "42",
      choices: null,
      mode: "live",
      kind: "owner",
    } as const;
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
            items: [{ kind: "file", id: "t4", name: "F.pdf", type: "pdf", size: null }],
          }),
        }),
      ),
    ).toBe("pdf_file");
    expect(
      phoneKey(
        ctx({
          view: phoneView("open", {
            openMode: "pdf",
            items: [{ kind: "file", id: "t5", name: "F.pptx", type: "pptx", size: null }],
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

  it("a result outranks any error pushed after it: the screen dropping the pairing never reads as expired", () => {
    for (const error of ["expired", "taken", "offline", "error"] as const) {
      expect(phoneKey(ctx({ error, view: phoneView("ended", { endReason: "phone" }) })), error).toBe("ended");
      expect(phoneKey(ctx({ error, view: phoneView("ended", { endReason: "canceled" }) })), error).toBe("canceled");
      expect(phoneKey(ctx({ error, canceled: true })), error).toBe("canceled");
    }
    // Before a result, the error still wins over the live state.
    expect(phoneKey(ctx({ error: "expired", view: phoneView("open") }))).toBe("expired");
  });

  it("a repeat that lost the race (a guest's re-sent file, another set) reads as taken until this pairing's session view arrives", () => {
    expect(phoneKey(ctx({ error: "taken", view: phoneView("choosing") }))).toBe("taken");
    for (const state of IN_SESSION) {
      const view = phoneView(state);
      expect(phoneKey(ctx({ error: "taken", view })), state).toBe(phoneKey(ctx({ view })));
      expect(["opening", "open"], state).toContain(phoneKey(ctx({ view })));
    }
    // A guest whose re-sent file got already_uploaded sees the session once the screen opens the file.
    expect(phoneKey(ctx({ error: "taken", view: phoneView("approved", { kind: "guest" }) }))).toBe("opening");
    // Any other failure still shows over the session (offline keeps Revoke beside it).
    expect(phoneKey(ctx({ error: "offline", view: phoneView("open") }))).toBe("offline");
  });

  it("a pairing that fell back to waiting is expired", () => {
    expect(phoneKey(ctx({ view: phoneView("waiting") }))).toBe("expired");
  });

  it("a phone that picked a file walks confirm, sending in its own order", () => {
    for (const drop of ["confirm", "sending"] as const) {
      expect(phoneKey(ctx({ drop, files: [file("a")], selected: ["a"] }))).toBe(`guest_${drop}`);
    }
  });

  it("a guest with no list lands on Add a File, before the first view arrives too", () => {
    const info = { ...base.info, kind: "guest" } as PhoneCtx["info"];
    expect(phoneKey(ctx({ drop: null, files: [], view: null, info }))).toBe("guest_add");
  });

  it("the server's word wins: an offer is sent, an upload is sending, a claimed guest adds", () => {
    expect(phoneKey(ctx({ drop: "sending", view: phoneView("offered", { kind: "guest" }) }))).toBe("guest_sent");
    expect(phoneKey(ctx({ drop: null, view: phoneView("uploading", { kind: "guest" }) }))).toBe("guest_sending");
    expect(phoneKey(ctx({ drop: null, view: phoneView("claimed", { kind: "guest" }) }))).toBe("guest_add");
    expect(phoneKey(ctx({ drop: "confirm", view: phoneView("claimed", { kind: "guest" }) }))).toBe("guest_confirm");
  });

  it("a refusal shows over the guest flow, and an opened drop shows as open", () => {
    expect(phoneKey(ctx({ drop: null, error: "guest_refused" }))).toBe("guest_refused");
    expect(phoneKey(ctx({ view: phoneView("open", { kind: "guest", openMode: "protocol" }) }))).toBe("open");
    expect(phoneKey(ctx({ view: phoneView("approved", { kind: "guest" }) }))).toBe("opening");
  });

  it("an error replaces the flow", () => {
    expect(phoneKey(ctx({ error: "taken", files: [file("a")], selected: ["a"] }))).toBe("taken");
    expect(phoneKey(ctx({ error: "taken", info: null, view: null }))).toBe("taken");
  });
});

describe("PAIR-14 the live pick comes first", () => {
  const info = {
    roomName: null,
    registered: false,
    match: null,
    choices: ["17", "42", "86"],
    mode: "live",
    kind: "owner",
  } as const;
  const c = (over: Partial<PhoneCtx>): PhoneCtx => ({
    error: null,
    info: { ...info, choices: [...info.choices] },
    view: null,
    files: null,
    selected: [],
    approving: false,
    canceled: false,
    drop: null,
    ...over,
  });
  const unconfirmed = phoneView("claimed", { match: null, choices: ["17", "42", "86"], confirmed: false });
  // What phone.js renders: core/states.js's key with the pick over it.
  const key = (ctx: PhoneCtx) => withPick(ctx, phoneKey(ctx));

  it("from the claim's answer, before any view, and on an unconfirmed view (a reload too)", () => {
    expect(key(c({}))).toBe("pick");
    expect(key(c({ view: unconfirmed }))).toBe("pick");
  });

  it("once confirmed, the chooser follows: the list loading, then choose", () => {
    expect(key(c({ view: phoneView("claimed") }))).toBe("match");
    expect(key(c({ view: phoneView("claimed"), files: [file("a")] }))).toBe("choose");
  });

  it("a wrong pick's dead end and a dropped claim win over the pick", () => {
    expect(key(c({ error: "match_wrong", view: unconfirmed }))).toBe("match_wrong");
    expect(key(c({ view: phoneView("waiting") }))).toBe("expired");
  });

  it("a demo claim has no choices, so it never picks", () => {
    expect(key(c({ info: { ...info, mode: "demo", choices: null, match: "42" } }))).toBe("match");
  });
});

describe("the room screen's first load carries none of the pick", () => {
  it("core/states.js, in the screen's bundle, has no pick branch; the guest keys and the chooser pass through", () => {
    const states = readFileSync(new URL("../../public/js/core/states.js", import.meta.url), "utf8");
    for (const word of ['"pick"', "choices", "confirmed", "withPick"]) expect(states, word).not.toContain(word);
    const budgets = JSON.parse(readFileSync(new URL("../../tools/size/core.json", import.meta.url), "utf8")) as {
      name: string;
      path: string | string[];
    }[];
    const screen = budgets.find((b) => b.name === "room screen JS")?.path ?? [];
    expect(screen).toContain("dist/js/core/states.js");
    expect(screen).not.toContain("dist/js/core/copy-phone.js");
    const screenJs = readFileSync(new URL("../../public/js/screen.js", import.meta.url), "utf8");
    expect(screenJs).not.toContain("copy-phone.js");
  });

  it("the pick never replaces a key outside the chooser", () => {
    const live = { info: { choices: ["17", "42", "86"] }, view: null };
    for (const k of [
      "checking",
      "expired",
      "opening",
      "open",
      "canceled",
      "ended",
      "match_wrong",
      "guest_sent",
    ] as const)
      expect(withPick(live, k), k).toBe(k);
    for (const k of ["match", "choose", "approve", "unregistered", "guest_add"] as const)
      expect(withPick(live, k), k).toBe("pick");
    expect(withPick({ ...live, view: { confirmed: true } }, "match")).toBe("match");
    expect(withPick({ info: { choices: null }, view: null }, "match")).toBe("match");
  });
});

describe("PAIR-12 the phone takes a view", () => {
  const taking = (kind: "owner" | "guest", files: FileEntry[] | null = null, selected: string[] = []) => ({
    pid: null as string | null,
    view: null as PhoneView | null,
    skew: 0,
    info: { roomName: "Room 2.14", registered: true, match: "42", mode: "live", kind } as PhoneCtx["info"],
    files: files as PhoneCtx["files"],
    selected,
  });

  it("a resumed pid is set before its view, so a pairing already over drops that pid", () => {
    const c = taking("owner");
    const drop = vi.fn();
    adopt(c, phoneView("ended", { endReason: "phone" }), drop, "PID-1");
    expect(c.pid).toBe("PID-1");
    expect(drop).toHaveBeenCalledWith("PID-1");
  });

  it("an owner turned guest by its first byte keeps no OneDrive list, only the Add a File row", () => {
    const c = taking("owner", [file("a"), file("b")], ["a"]);
    const before = c.info;
    adopt(c, phoneView("claimed", { kind: "guest" }), vi.fn());
    expect(c.files).toEqual([]);
    expect(c.selected).toEqual([]);
    expect(c.info?.kind).toBe("guest");
    expect(before?.kind).toBe("owner");
    expect(phoneKey({ ...c, error: null, approving: false, canceled: false, drop: null })).toBe("guest_add");
  });

  it("an owner's own view, and a guest's, leave the list as it is", () => {
    const owner = taking("owner", [file("a")], ["a"]);
    adopt(owner, phoneView("open"), vi.fn());
    expect(owner.files).toHaveLength(1);
    expect(owner.selected).toEqual(["a"]);
    const guest = taking("guest", []);
    const files = guest.files;
    adopt(guest, phoneView("claimed", { kind: "guest" }), vi.fn());
    expect(guest.files).toBe(files);
  });

  it("a live view keeps the pid; a pairing that fell back to waiting drops it", () => {
    const c = { ...taking("owner"), pid: "PID-1" as string | null };
    const drop = vi.fn();
    adopt(c, phoneView("open"), drop);
    expect(drop).not.toHaveBeenCalled();
    adopt(c, phoneView("waiting"), drop);
    expect(drop).toHaveBeenCalledWith("PID-1");
  });

  /** The page's onError, as phone.js wires it, over a context at the given view. */
  const refuse = (view: PhoneView | null, code: ErrorCode, over: Partial<PhoneCtx & { canceling: boolean }> = {}) => {
    const act = { drop: vi.fn(), stop: vi.fn(), fail: vi.fn() };
    const c = {
      error: null,
      info: {
        roomName: "Room",
        registered: true,
        match: "42",
        choices: null,
        mode: "live" as const,
        kind: "owner" as const,
      },
      view,
      files: null,
      selected: [],
      approving: false,
      canceled: false,
      drop: null,
      canceling: false,
      ...over,
    };
    onRefusal(c, code, act);
    return act;
  };

  it("after a result a refusal only drops and stops: the result stays, nothing reconnects", () => {
    for (const view of [phoneView("ended", { endReason: "phone" }), phoneView("ended", { endReason: "canceled" })]) {
      const act = refuse(view, "rate_limited");
      expect(act.drop).toHaveBeenCalledOnce();
      expect(act.stop).toHaveBeenCalledOnce();
      expect(act.fail).not.toHaveBeenCalled();
    }
    expect(refuse(phoneView("claimed"), "pairing_invalid", { canceled: true }).fail).not.toHaveBeenCalled();
  });

  it("before a result a refusal shows; only a dead one drops the pid; this phone's own cancel shows nothing", () => {
    const live = refuse(phoneView("open"), "rate_limited");
    expect(live.fail).toHaveBeenCalledWith("rate_limited");
    expect(live.drop).not.toHaveBeenCalled();
    expect(live.stop).not.toHaveBeenCalled();
    const dead = refuse(phoneView("open"), "pairing_invalid");
    expect(dead.drop).toHaveBeenCalledOnce();
    expect(dead.fail).toHaveBeenCalledWith("pairing_invalid");
    expect(refuse(phoneView("claimed"), "pairing_invalid", { canceling: true }).fail).not.toHaveBeenCalled();
  });
});

describe("PAIR-12 Back and Done", () => {
  const io = () => ({ post: vi.fn(async () => ({ ok: true })), drop: vi.fn(), assign: vi.fn() });
  const at = (view: PhoneView | null, over: { canceled?: boolean; pid?: string | null } = {}) => ({
    pid: "PID-1" as string | null,
    canceled: false,
    view,
    leaving: false,
    ...over,
  });

  it("a claim not yet approved is live; a session, a result or a canceled claim is not", () => {
    for (const state of ["claimed", "choosing"] as const) expect(liveClaim(at(phoneView(state))), state).toBe(true);
    expect(liveClaim(at(null))).toBe(true);
    for (const state of ["approved", "open", "offered", "ended", "waiting"] as const)
      expect(liveClaim(at(phoneView(state))), state).toBe(false);
    expect(liveClaim(at(phoneView("claimed"), { canceled: true }))).toBe(false);
    expect(liveClaim(at(phoneView("claimed"), { pid: null }))).toBe(false);
  });

  it("Back or Done on a live claim cancels it first, then forgets the pid and leaves", async () => {
    for (const forget of [false, true]) {
      const deps = io();
      await leave(at(phoneView("choosing")), deps, "/", forget);
      expect(deps.post).toHaveBeenCalledWith("/api/cancel", {}, "PID-1");
      expect(deps.drop).toHaveBeenCalledWith("PID-1");
      expect(deps.assign).toHaveBeenCalledWith("/");
      expect(deps.post.mock.invocationCallOrder[0]).toBeLessThan(deps.drop.mock.invocationCallOrder[0] ?? 0);
    }
  });

  it("Back in a live session (offline, an error) keeps the pid, so Revoke can come back; Done forgets it", async () => {
    const back = io();
    await leave(at(phoneView("open")), back, "/");
    expect(back.post).not.toHaveBeenCalled();
    expect(back.drop).not.toHaveBeenCalled();
    expect(back.assign).toHaveBeenCalledWith("/");
    const done = io();
    await leave(at(phoneView("ended", { endReason: "phone" })), done, "/", true);
    expect(done.post).not.toHaveBeenCalled();
    expect(done.drop).toHaveBeenCalledWith("PID-1");
  });

  it("a second tap while the first waits on its cancel does nothing", async () => {
    const deps = io();
    const c = at(phoneView("claimed"));
    const first = leave(c, deps, "/");
    await leave(c, deps, "/");
    await first;
    expect(deps.post).toHaveBeenCalledOnce();
    expect(deps.assign).toHaveBeenCalledOnce();
  });

  it("Back whose cancel is refused (the approve landed first) or fails offline keeps the pid; Done still forgets", async () => {
    for (const forget of [false, true]) {
      const deps = { ...io(), post: vi.fn(async () => ({ ok: false })) };
      await leave(at(phoneView("claimed")), deps, "/", forget);
      expect(deps.post).toHaveBeenCalledOnce();
      expect(deps.drop).toHaveBeenCalledTimes(forget ? 1 : 0);
      expect(deps.assign).toHaveBeenCalledWith("/");
    }
  });
});

describe("Try Again", () => {
  const failed = (view: PhoneView | null) => {
    const run = vi.fn();
    return { run, c: { error: "offline" as unknown, retry: run as (() => void) | null, view } };
  };

  it("before the session, clears the failure and returns the call to rerun", () => {
    const { run, c } = failed(phoneView("choosing"));
    expect(retryStep(c)).toBe(run);
    expect(c).toMatchObject({ error: null, retry: null });
  });

  it("once the session is up, only clears the failure: a landed approve is never posted again", () => {
    for (const state of IN_SESSION) {
      const { c } = failed(phoneView(state));
      expect(retryStep(c), state).toBeNull();
      expect(c).toMatchObject({ error: null, retry: null });
    }
  });
});
