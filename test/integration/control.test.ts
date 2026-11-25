// The remote against `wrangler dev` (PAIR-13): POST /api/control (the phone's pid) and POST /api/screen/shown (the
// screen's sid), both on the demo account. The demo catalog approves as Dog.jpg i1, Sample deck.pdf i2, Sample
// deck.pptx i3 and the Vevox link i4: files by name, then links.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveDemo, sleep } from "./open-client.ts";
import { Api, claim, openScreen, phoneSocket, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing();
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const problem = (code: string) => expect.objectContaining({ code });
const ALL = ["demo-deck", "demo-pdf", "demo-dog", "demo-vevox"];
const DECK = "i3";
const LINK = "i4";
const shown = (item: string, page = 1, present = false) => ({ item, page, present });
let clock = 0;
/** A request body: `shown` plus a newer seq per call, as a sender's clock gives. */
const cmd = (item: string, page = 1, present = false, seq = ++clock) => ({ ...shown(item, page, present), seq });

/** An approved demo session with every catalog item. */
const session = () => approveDemo(api, ALL);

describe("PAIR-13 item ids: both views carry a server id per item", () => {
  it("PAIR-13 ids: the screen and the phone see the same opaque ids, in list order, with no source id", async () => {
    const { socket, pid } = await session();
    const view = (await socket.stateWhere((v) => v.state === "approved")).view as { items: { id: string }[] };
    expect(view.items.map((i) => i.id)).toEqual(["i1", "i2", "i3", "i4"]);
    const phone = await api.get<{ items: { id: string }[]; shown: unknown }>("/api/pair/state", pid);
    expect(phone.body.items.map((i) => i.id)).toEqual(["i1", "i2", "i3", "i4"]);
    expect(phone.body.shown).toBeNull();
    expect(JSON.stringify(phone.body)).not.toContain("demo-deck");
    socket.close();
  });
});

describe("PAIR-13 control: only the pairing's phone commands the screen", () => {
  it("PAIR-13 control: a command reaches the phone's reply, the screen's socket and the phone's socket", async () => {
    const { screen, socket, pid } = await session();
    const phone = await phoneSocket(api, pid);
    const res = await api.post<{ shown: unknown }>("/api/control", cmd(DECK, 2, true), { auth: pid });
    expect(res.status).toBe(200);
    expect(res.body.shown).toEqual(shown(DECK, 2, true));
    await socket.stateWhere((v) => JSON.stringify(v.shown) === JSON.stringify(shown(DECK, 2, true)));
    await phone.stateWhere((v) => JSON.stringify(v.shown) === JSON.stringify(shown(DECK, 2, true)));
    // A reloaded or polling screen catches up from state, with no frame of its own.
    const polled = await api.get<{ shown: unknown }>("/api/screen/state", screen.sid);
    expect(polled.body.shown).toEqual(shown(DECK, 2, true));
    socket.close();
    phone.close();
  });

  it("PAIR-13 replay: the same absolute command twice changes nothing and pushes nothing", async () => {
    const { socket, pid } = await session();
    const first = await api.post("/api/control", cmd(DECK, 2), { auth: pid });
    await socket.stateWhere((v) => JSON.stringify(v.shown) === JSON.stringify(shown(DECK, 2)));
    const seen = socket.frames.length;
    const again = await api.post("/api/control", cmd(DECK, 2), { auth: pid });
    await sleep(300);
    expect(again.status).toBe(200);
    expect(again.body.shown).toEqual((first.body as { shown: unknown }).shown);
    expect(socket.frames.length).toBe(seen);
    socket.close();
  });

  it("PAIR-13 pid: a wrong pid, a screen's sid and no credential are refused", async () => {
    const { screen, socket, pid } = await session();
    const [ref] = pid.split(".");
    const forged = await api.post("/api/control", cmd(DECK), { auth: `${ref}.${"A".repeat(43)}` });
    expect(forged.body).toEqual(problem("pairing_invalid"));
    const asScreen = await api.post("/api/control", cmd(DECK), { auth: screen.sid });
    expect(asScreen.body).toEqual(problem("pairing_invalid"));
    const bare = await api.post("/api/control", cmd(DECK));
    expect(bare.body).toEqual(problem("unauthorized"));
    // Another session's phone has no say here.
    const other = await session();
    const crossed = await api.post("/api/control", cmd(DECK), { auth: other.pid });
    expect(crossed.status).toBe(200);
    expect((await api.get<{ shown: unknown }>("/api/pair/state", pid)).body.shown).toBeNull();
    socket.close();
    other.socket.close();
  });

  it("PAIR-06 csrf: a cross-origin, form-encoded or unknown-key request is refused", async () => {
    const { socket, pid } = await session();
    const cross = await api.post("/api/control", cmd(DECK), { auth: pid, origin: "https://evil.example" });
    expect(cross.body).toEqual(problem("forbidden_origin"));
    const form = await api.post("/api/control", undefined, {
      auth: pid,
      contentType: "application/x-www-form-urlencoded",
      raw: "item=i3&page=1&present=false&seq=1",
    });
    expect(form.body).toEqual(problem("unsupported_media_type"));
    const extra = await api.post("/api/control", { ...cmd(DECK), extra: 1 }, { auth: pid });
    expect(extra.body).toEqual(problem("bad_request"));
    socket.close();
  });

  it("PAIR-13 schema: a missing key or seq, a wrong type, a page or seq out of bounds, a fraction and a long id are bad_request", async () => {
    const { socket, pid } = await session();
    for (const body of [
      shown(DECK),
      { ...shown(DECK), seq: 0 },
      { ...shown(DECK), seq: 1.5 },
      { ...shown(DECK), seq: "1" },
      { item: DECK, page: 1, seq: 1 },
      ...[
        { item: DECK, page: "1", present: false },
        { item: DECK, page: 0, present: false },
        { item: DECK, page: -1, present: false },
        { item: DECK, page: 1001, present: false },
        { item: DECK, page: 1.5, present: false },
        { item: DECK, page: 1, present: "yes" },
        { item: "", page: 1, present: false },
        { item: "i".repeat(33), page: 1, present: false },
        { item: 3, page: 1, present: false },
      ].map((body) => ({ ...body, seq: 1 })),
    ]) {
      expect((await api.post("/api/control", body, { auth: pid })).body, JSON.stringify(body)).toEqual(
        problem("bad_request"),
      );
    }
    socket.close();
  });

  it("PAIR-13 order: a command older than the phone's last one changes nothing, and the screen's own seq is separate", async () => {
    const { screen, socket, pid } = await session();
    expect((await api.post("/api/control", cmd(DECK, 2, false, 100), { auth: pid })).status).toBe(200);
    const late = await api.post<{ shown: unknown }>("/api/control", cmd(DECK, 1, false, 99), { auth: pid });
    expect(late.status).toBe(200);
    expect(late.body.shown).toEqual(shown(DECK, 2));
    const tap = await api.post<{ shown: unknown }>("/api/screen/shown", cmd(DECK, 1, false, 1), { auth: screen.sid });
    expect(tap.body.shown).toEqual(shown(DECK, 1));
    socket.close();
  });

  it("LINK-01 link: a link item is never remote-opened", async () => {
    const { socket, pid } = await session();
    const res = await api.post("/api/control", cmd(LINK), { auth: pid });
    expect(res.body).toEqual(problem("file_not_found"));
    expect((await api.get<{ shown: unknown }>("/api/pair/state", pid)).body.shown).toBeNull();
    socket.close();
  });

  it("PAIR-11 unknown: an id outside the list, and a list index, are file_not_found", async () => {
    const { socket, pid } = await session();
    for (const item of ["i9", "0", "demo-deck"]) {
      expect((await api.post("/api/control", cmd(item), { auth: pid })).body, item).toEqual(problem("file_not_found"));
    }
    socket.close();
  });

  it("PAIR-13 range: a page past the item's pages is bad_request, and the photo has one", async () => {
    const { socket, pid } = await session();
    expect((await api.post("/api/control", cmd(DECK, 3), { auth: pid })).body).toEqual(problem("bad_request"));
    expect((await api.post("/api/control", cmd("i1", 2), { auth: pid })).body).toEqual(problem("bad_request"));
    expect((await api.post("/api/control", cmd("i1", 1), { auth: pid })).status).toBe(200);
    socket.close();
  });

  it("PAIR-13 state: before approval and after the end it is wrong_state", async () => {
    const claimedOnly = await openScreen(api, "demo");
    const { body } = await claim(api, claimedOnly.code);
    const early = await api.post("/api/control", cmd(DECK), { auth: body.pid });
    expect(early.body).toEqual(problem("wrong_state"));
    claimedOnly.socket.close();

    const { socket, pid } = await session();
    await api.post("/api/end", {}, { auth: pid });
    expect((await api.post("/api/control", cmd(DECK), { auth: pid })).body).toEqual(problem("wrong_state"));
    socket.close();
  });

  it("PAIR-13 live: a live session has no viewer, so the remote is refused", async () => {
    const { screen, socket, code } = await openScreen(api, "live");
    const { body } = await claim(api, code);
    await api.get("/api/files", body.pid);
    expect((await api.post("/api/approve", { ids: ["demo-deck"] }, { auth: body.pid })).status).toBe(200);
    expect((await api.post("/api/control", cmd("i1"), { auth: body.pid })).body).toEqual(problem("wrong_state"));
    expect((await api.post("/api/screen/shown", cmd("i1"), { auth: screen.sid })).body).toEqual(problem("wrong_state"));
    socket.close();
  });
});

describe("PAIR-13 screen/shown: the screen reports its own taps", () => {
  it("PAIR-13 shown: the screen's report reaches the phone's view and its socket", async () => {
    const { screen, socket, pid } = await session();
    const phone = await phoneSocket(api, pid);
    const res = await api.post<{ shown: unknown }>("/api/screen/shown", cmd(DECK, 2), { auth: screen.sid });
    expect(res.status).toBe(200);
    expect(res.body.shown).toEqual(shown(DECK, 2));
    await phone.stateWhere((v) => JSON.stringify(v.shown) === JSON.stringify(shown(DECK, 2)));
    expect((await api.get<{ shown: unknown }>("/api/pair/state", pid)).body.shown).toEqual(shown(DECK, 2));
    // A replay is a no-op here too.
    const seen = phone.frames.length;
    expect((await api.post("/api/screen/shown", cmd(DECK, 2), { auth: screen.sid })).status).toBe(200);
    await sleep(300);
    expect(phone.frames.length).toBe(seen);
    socket.close();
    phone.close();
  });

  it("PAIR-13 sid: the phone's pid, a forged sid and no credential are refused", async () => {
    const { screen, socket, pid } = await session();
    const [ref] = screen.sid.split(".");
    expect((await api.post("/api/screen/shown", cmd(DECK), { auth: pid })).body).toEqual(problem("unauthorized"));
    const forged = await api.post("/api/screen/shown", cmd(DECK), { auth: `${ref}.${"A".repeat(43)}` });
    expect(forged.body).toEqual(problem("unauthorized"));
    expect((await api.post("/api/screen/shown", cmd(DECK))).body).toEqual(problem("unauthorized"));
    expect((await api.get<{ shown: unknown }>("/api/pair/state", pid)).body.shown).toBeNull();
    socket.close();
  });

  it("PAIR-13 shown: the same file-only, in-range and state rules as the phone's", async () => {
    const { screen, socket, pid } = await session();
    const post = (body: unknown) => api.post("/api/screen/shown", body, { auth: screen.sid });
    expect((await post(cmd(LINK))).body).toEqual(problem("file_not_found"));
    expect((await post(cmd("i9"))).body).toEqual(problem("file_not_found"));
    expect((await post(cmd(DECK, 3))).body).toEqual(problem("bad_request"));
    expect((await post({ ...cmd(DECK), extra: true })).body).toEqual(problem("bad_request"));
    expect(
      (await api.post("/api/screen/shown", cmd(DECK), { auth: screen.sid, origin: "https://evil.example" })).body,
    ).toEqual(problem("forbidden_origin"));
    await api.post("/api/end", {}, { auth: pid });
    expect((await post(cmd(DECK))).body).toEqual(problem("wrong_state"));
    socket.close();
  });
});
