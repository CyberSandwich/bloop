// Speaker notes against `wrangler dev` (NOTES-01 phone-only): GET /api/notes answers the pairing's pid for an item of
// its own session, and no screen-visible payload (view, poll, socket frame, link) ever carries a note.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_IDS, DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import { approveDemo } from "./open-client.ts";
import { Api, claim, openScreen, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const NOTES = JSON.parse(
  readFileSync(new URL("../../src/worker/seams/file-source/demo-files/demo-notes.json", import.meta.url), "utf8"),
) as string[];
/** How a note's opening reads inside JSON text, so a leak is found whatever the quoting. */
const SNIPPETS = NOTES.filter((n) => n !== "").map((n) => JSON.stringify(n.slice(0, 20)).slice(1, -1));
const DECK = DEMO_ITEMS.deck.slot;
const PHOTO = DEMO_ITEMS.horizontal.slot;
const LINK = DEMO_ITEMS.link.slot;

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing();
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const problem = (code: string) => expect.objectContaining({ code });
const notesOf = (item: string, auth?: string) => api.get<{ notes: string[] }>(`/api/notes?item=${item}`, auth);
const session = () => approveDemo(api, DEMO_IDS);
const expectNoNotes = (what: string, payload: unknown) => {
  const text = JSON.stringify(payload);
  for (const snippet of SNIPPETS) expect(text, `${what} carries a note`).not.toContain(snippet);
};

describe("NOTES-01 phone-only: the phone reads notes", () => {
  it("NOTES-01 phone-only: the deck's notes are the data file, one per page, uncached", async () => {
    expect(SNIPPETS.length).toBeGreaterThan(0);
    const { socket, pid } = await session();
    const res = await notesOf(DECK, pid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: NOTES });
    expect(res.headers.get("cache-control")).toBe("no-store");
    socket.close();
  });

  it("NOTES-01 phone-only: a photo and a link have none", async () => {
    const { socket, pid } = await session();
    expect((await notesOf(PHOTO, pid)).body).toEqual({ notes: [] });
    expect((await notesOf(LINK, pid)).body).toEqual({ notes: [] });
    socket.close();
  });

  it("NOTES-01 phone-only: a guest pairing with no approved item is refused, never answered with notes", async () => {
    const { code, socket } = await openScreen(api, "demo");
    const claimed = await claim(api, code, "guest");
    const res = await notesOf(DECK, claimed.body.pid);
    // A guest session holds no approved item yet: refused, and never a note.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNoNotes("guest answer", res.body);
    socket.close();
  });
});

describe("NOTES-01 phone-only: refusals", () => {
  it("NOTES-01 phone-only: no credential is 401", async () => {
    const res = await notesOf(DECK);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(problem("unauthorized"));
  });

  it("NOTES-01 phone-only: a malformed credential is 401", async () => {
    const res = await notesOf(DECK, "not-a-credential");
    expect(res.status).toBe(401);
  });

  it("NOTES-01 phone-only: the screen's sid is refused, even with a good item", async () => {
    const { screen, socket } = await session();
    const res = await notesOf(DECK, screen.sid);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toEqual(problem("pairing_invalid"));
    expectNoNotes("sid answer", res.body);
    socket.close();
  });

  it("NOTES-01 phone-only: another session's pid, and a forged secret, are refused", async () => {
    const mine = await session();
    const other = await session();
    const [ref] = mine.pid.split(".");
    const secretOfOther = other.pid.split(".")[1];
    const crossed = await notesOf(DECK, `${ref}.${secretOfOther}`);
    expect(crossed.body).toEqual(problem("pairing_invalid"));
    const forged = await notesOf(DECK, `${ref}.${"A".repeat(43)}`);
    expect(forged.body).toEqual(problem("pairing_invalid"));
    mine.socket.close();
    other.socket.close();
  });

  it("NOTES-01 phone-only: an item id the session does not hold is file_not_found; a missing or long id is bad_request", async () => {
    const { socket, pid } = await session();
    expect((await notesOf("zz9", pid)).body).toEqual(problem("file_not_found"));
    expect((await api.get("/api/notes", pid)).body).toEqual(problem("bad_request"));
    expect((await notesOf("x".repeat(33), pid)).body).toEqual(problem("bad_request"));
    socket.close();
  });

  it("NOTES-01 phone-only: a source file ref is not an item id", async () => {
    const { socket, pid } = await session();
    expect((await notesOf(DEMO_ITEMS.deck.id, pid)).body).toEqual(problem("file_not_found"));
    socket.close();
  });

  it("NOTES-01 phone-only: before approval is wrong_state", async () => {
    const { code, socket } = await openScreen(api, "demo");
    const claimed = await claim(api, code);
    await api.get("/api/files", claimed.body.pid);
    const res = await notesOf(DECK, claimed.body.pid);
    expect(res.body).toEqual(problem("wrong_state"));
    socket.close();
  });

  it("NOTES-01 phone-only: after the end is wrong_state, and notes are not served", async () => {
    const { socket, pid } = await session();
    expect((await notesOf(DECK, pid)).status).toBe(200);
    expect((await api.post("/api/end", {}, { auth: pid })).status).toBe(200);
    const res = await notesOf(DECK, pid);
    expect(res.body).toEqual(problem("wrong_state"));
    expectNoNotes("ended answer", res.body);
    socket.close();
  });
});

describe("NOTES-01 phone-only: nothing the screen can read carries a note", () => {
  it("NOTES-01 phone-only: the screen's poll, its socket and its links hold no note, approved or shown", async () => {
    const { screen, socket, pid } = await session();
    const approved = await api.get("/api/screen/state", screen.sid);
    expectNoNotes("poll after approval", approved.body);
    // The phone has read the notes: a view built afterward is the same state, still without them.
    expect((await notesOf(DECK, pid)).body).toEqual({ notes: NOTES });
    const shown = await api.post(
      "/api/control",
      { item: DECK, page: 2, present: true, seq: Date.now() },
      { auth: pid },
    );
    expect(shown.status).toBe(200);
    await socket.stateWhere((v) => (v.shown as { page?: number } | null)?.page === 2);
    const polled = await api.get("/api/screen/state", screen.sid);
    expectNoNotes("poll while shown", polled.body);
    expectNoNotes("socket frames", socket.frames);
    const link = await api.post("/api/screen/link", { purpose: "download", item: DECK }, { auth: screen.sid });
    expectNoNotes("minted link", link.body);
    // The phone's own views are views too: notes are not part of them either.
    expectNoNotes("phone view", (await api.get("/api/pair/state", pid)).body);
    socket.close();
  });
});
