// Demo mode against `wrangler dev` (docs/architecture.md 4.5, ADR 0007): the whole flow on the demo account,
// the off switch, the per-IP limits and the global cap. The flow runs with TEST_TIMING and a migrated D1; the
// limits run on instances with the platform bindings live (no TEST_TIMING) or with a tiny cap.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveDemo, fetchLink, sleep } from "./open-client.ts";
import { Api, claim, openScreen, PEPPER, startPairing } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

const ip = (address: string) => ({ headers: { "CF-Connecting-IP": address } });
const problem = (status: number, code: string) => ({ type: "about:blank", status, code });

/** A demo screen's current code, read by polling (which issues one when none is fresh). */
async function demoCode(api: Api, from: string): Promise<{ sid: string; code: string }> {
  const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" }, ip(from));
  expect(created.status).toBe(201);
  const state = await api.get<{ code: { code: string } }>("/api/screen/state", created.body.sid);
  return { sid: created.body.sid, code: state.body.code.code };
}

describe("DEMO-01 isolation: the full demo flow, with no account", () => {
  let wrangler: Wrangler;
  let api: Api;
  beforeAll(async () => {
    wrangler = await startPairing({}, { migrate: true });
    api = new Api(wrangler.url);
  });
  afterAll(() => wrangler?.stop());

  it("DEMO-01 flow: create, claim, match, list, approve, fetch the open link, end", async () => {
    const { screen, socket, code } = await openScreen(api, "demo");
    expect(screen.view).toMatchObject({ state: "waiting", mode: "demo", room: { name: "Demo Room" } });

    // A phone holding a stale or forged account cookie is ignored: the demo never reads it.
    const claimed = await api.post<{
      pid: string;
      match: string;
      mode: string;
      needsAuth: boolean;
      dropMaxBytes: number;
    }>("/api/claim", { code }, { headers: { Cookie: "__Host-bloop_sid=forged" } });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ mode: "demo", needsAuth: false, dropMaxBytes: 26_214_400 });
    expect(claimed.body.match).toMatch(/^[0-9]{2}$/);
    await socket.stateWhere((v) => v.state === "claimed" && v.match === claimed.body.match);

    // The demo catalog: the deck, its PDF, a photo and one link (LINK-01: it passed the allowlist to be listed).
    const files = await api.get<{ items: { id: string }[] }>("/api/files", claimed.body.pid);
    expect(files.body.items.map((f) => f.id)).toEqual(["demo-deck", "demo-pdf", "demo-dog", "demo-vevox"]);

    const approved = await api.post("/api/approve", { ids: ["demo-deck"] }, { auth: claimed.body.pid });
    expect(approved.status).toBe(200);
    const open = await socket.waitFor((f) => f.t === "open");
    const links = open.links as { protocol: string };
    const url = links.protocol.replace("ms-powerpoint:ofv|u|", "");

    // A session lasts DEMO_SESSION_MINUTES (60), not the live 90.
    const view = (await socket.stateWhere((v) => v.state === "approved")).view as { endsAt: number; now: number };
    expect(view.endsAt - view.now).toBeLessThanOrEqual(60 * 60_000);
    expect(view.endsAt - view.now).toBeGreaterThan(59 * 60_000);

    socket.send({ t: "launched", mode: "protocol" });
    const fetched = await fetchLink(url);
    expect(fetched.status).toBe(200);
    expect([...new Uint8Array(await fetched.arrayBuffer()).slice(0, 2)]).toEqual([0x50, 0x4b]);
    await socket.stateWhere((v) => v.state === "open");

    const ended = await api.post("/api/screen/end", {}, { auth: screen.sid });
    expect(ended.status).toBe(200);
    await socket.stateWhere((v) => v.state === "ended");
    expect((await fetchLink(url)).status).toBe(410);
    socket.close();
  });

  it("DEMO-01 flow: the phone ends a demo too, and an unlisted or second set of ids is refused", async () => {
    const { socket, pid } = await approveDemo(api);
    for (const fileId of ["not-in-the-account", "demo-pdf", "demo-review"]) {
      expect((await api.post("/api/approve", { ids: [fileId] }, { auth: pid })).status, fileId).toBeGreaterThanOrEqual(
        400,
      );
    }
    expect((await api.post("/api/end", {}, { auth: pid })).status).toBe(200);
    await socket.stateWhere((v) => v.state === "ended");
    socket.close();
  });

  it("IMG-01 image items and LINK-01 link items: a whole-catalog session serves each file its own way, and no link is minted", async () => {
    const { screen, socket, code } = await openScreen(api, "demo");
    const pid = (await claim(api, code)).body.pid;
    await api.get("/api/files", pid);
    const ids = ["demo-vevox", "demo-dog", "demo-pdf", "demo-deck"];
    expect((await api.post("/api/approve", { ids }, { auth: pid })).status).toBe(200);
    // Items are files by name, then links: 0 Dog.jpg, 1 Sample deck.pdf, 2 Sample deck.pptx, 3 Vevox. The first file launches.
    const first = await socket.waitFor((f) => f.t === "open");
    expect(first.item).toBe(0);
    const firstLinks = first.links as { protocol: string | null; view: string | null };
    expect(firstLinks.protocol).toBeNull();
    const image = await fetchLink(firstLinks.view as string);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/jpeg");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(image.headers.get("Content-Disposition")).toBe("inline");
    expect(image.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(image.headers.get("Cache-Control")).toBe("no-store");
    expect([...new Uint8Array(await image.arrayBuffer()).slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    // The screen reports an image launch as view; the socket stays up and the session moves on.
    socket.send({ t: "launched", mode: "view" });
    await socket.stateWhere((v) => v.state === "opening" || v.state === "open");

    const mint = (body: Record<string, unknown>) =>
      api.post<{ item: number; links: Record<string, string | null> }>("/api/screen/link", body, { auth: screen.sid });
    const pdf = await mint({ purpose: "protocol", item: 1 });
    expect(pdf.body.item).toBe(1);
    const pdfView = await fetchLink(pdf.body.links.pdf as string);
    expect(pdfView.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdfView.headers.get("Content-Disposition")).toBe("inline");
    expect((await mint({ purpose: "view", item: 0 })).status).toBe(200);
    const deck = await mint({ purpose: "protocol", item: 2 });
    expect(deck.body.links.protocol).toMatch(/^ms-powerpoint:ofv\|u\|.*\.pptx$/);

    // A link item never becomes a /f/ link, and an index past the list names nothing (PAIR-11).
    expect((await mint({ purpose: "protocol", item: 3 })).body).toMatchObject({ code: "file_not_found" });
    expect((await mint({ purpose: "protocol", item: 11 })).body).toMatchObject({ code: "file_not_found" });
    expect((await mint({ purpose: "download", item: 12 })).status).toBe(400);

    const state = await api.get<{ items: { kind: string }[] }>("/api/screen/state", screen.sid);
    expect(state.body.items.map((i) => i.kind)).toEqual(["file", "file", "file", "link"]);
    expect(state.body.items[3]).toEqual({
      kind: "link",
      id: "i4",
      url: "https://www.vevox.com/",
      title: "Vevox",
    });
    socket.close();
  });

  it("DEMO-01 reload: a screen that comes back after Approve reads its result from state, re-asks for the link once, and its own fetch opens it", async () => {
    const { screen, socket } = await approveDemo(api);
    socket.close();

    // What /s does on a reload: the stored sid reads the state; no `open` frame is needed to show the result.
    const back = await api.get<Record<string, unknown>>("/api/screen/state", screen.sid);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      state: "approved",
      mode: "demo",
      kind: "owner",
      items: [{ kind: "file", name: "Sample deck.pptx", type: "pptx", size: expect.any(Number) }],
    });

    // The page asks for the link it missed and fetches it as PowerPoint would (a HEAD), which marks the file open.
    const relinked = await api.post<{ links: { protocol: string } }>(
      "/api/screen/link",
      { purpose: "protocol" },
      { auth: screen.sid },
    );
    expect(relinked.status).toBe(200);
    const url = relinked.body.links.protocol.replace("ms-powerpoint:ofv|u|", "");
    expect((await fetchLink(url, { method: "HEAD" })).status).toBe(200);
    const open = await api.get<{ state: string; openMode: string | null }>("/api/screen/state", screen.sid);
    expect(open.body).toMatchObject({ state: "open", openMode: null });

    // A second reload still finds it open, and End from the screen works with no socket at all.
    expect((await api.get<{ state: string }>("/api/screen/state", screen.sid)).body.state).toBe("open");
    expect((await api.post<{ state: string }>("/api/screen/end", {}, { auth: screen.sid })).body.state).toBe("ended");
  });

  it("DEMO-01 isolation: a demo screen's sid resumes only that screen, and a pid cannot read the screen's state", async () => {
    const mine = await approveDemo(api);
    const other = await openScreen(api, "demo");
    const forged = `${other.screen.ref}.${mine.screen.sid.split(".")[1]}`;
    expect((await api.get("/api/screen/state", forged)).status).toBe(401);
    expect((await api.get("/api/screen/state", mine.pid)).status).toBe(401);
    mine.socket.close();
    other.socket.close();
  });

  it("DEMO-04 records: a demo session is stored as mode demo with no user, and its audit rows say so", async () => {
    const { socket, pid } = await approveDemo(api);
    await api.post("/api/end", {}, { auth: pid });
    await socket.stateWhere((v) => v.state === "ended");
    let rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && !rows.some((r) => r.end_reason !== null); i++) {
      rows = wrangler.d1("SELECT mode, user_id, end_reason, source FROM session");
      await sleep(100);
    }
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ mode: "demo", user_id: null });
    expect(rows.some((r) => r.end_reason === "phone" && r.source === "mock")).toBe(true);
    expect(wrangler.d1("SELECT count(*) AS n FROM app_user")[0]).toEqual({ n: 0 });
    socket.close();
  });
});

describe("DEMO-03 off: DEMO_ENABLED=false turns every demo route off", () => {
  let wrangler: Wrangler;
  let api: Api;
  beforeAll(async () => {
    wrangler = await startPairing({ DEMO_ENABLED: "false" });
    api = new Api(wrangler.url);
  });
  afterAll(() => wrangler?.stop());

  it("DEMO-03 off: creating a demo screen answers 404 not_found", async () => {
    const res = await api.post("/api/screens", { mode: "demo" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(problem(404, "not_found"));
  });

  it("DEMO-03 off: the live path is untouched", async () => {
    const res = await api.post("/api/screens", { mode: "live" });
    expect(res.status).toBe(201);
    const state = await api.get<{ code: { code: string } }>("/api/screen/state", (res.body as { sid: string }).sid);
    expect((await claim(api, state.body.code.code)).status).toBe(200);
  });

  it("DEMO-03 off: the demo screen page and the landing still serve, so the stage can say it could not start", async () => {
    expect((await fetch(`${wrangler.url}/s?mode=demo`)).status).toBe(200);
    expect((await fetch(`${wrangler.url}/`)).status).toBe(200);
  });
});

describe("DEMO-02 flood: strict per-IP limits", () => {
  let wrangler: Wrangler;
  let api: Api;
  beforeAll(async () => {
    wrangler = await startWrangler({ HASH_PEPPER: PEPPER, DEMO_MAX_PER_IP: "1000" });
    api = new Api(wrangler.url);
  });
  afterAll(() => wrangler?.stop());

  it("DEMO-02 flood: demo screen creation is limited to 12 a minute per IP, and another IP is unaffected", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++)
      statuses.push((await api.post("/api/screens", { mode: "demo" }, ip("203.0.113.10"))).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(12);
    expect(statuses.slice(12)).toEqual([429, 429]);
    expect((await api.post("/api/screens", { mode: "demo" }, ip("203.0.113.11"))).status).toBe(201);
    // The live limit is its own binding: this IP can still create a live screen.
    expect((await api.post("/api/screens", { mode: "live" }, ip("203.0.113.10"))).status).toBe(201);
  });

  it("DEMO-02 flood: demo claims from one IP stop at 20 a minute, the live claim limit, which the demo one equals", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 21; i++) codes.push((await demoCode(api, `203.0.113.${20 + i}`)).code);
    const statuses: number[] = [];
    for (const code of codes) statuses.push((await api.post("/api/claim", { code }, ip("203.0.113.60"))).status);
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(statuses[20]).toBe(429);
    // Another phone is counted on its own.
    const fresh = await demoCode(api, "203.0.113.70");
    expect((await api.post("/api/claim", { code: fresh.code }, ip("203.0.113.61"))).status).toBe(200);
  });
});

describe("DEMO-02 flood: the global cap on concurrent demo sessions", () => {
  let wrangler: Wrangler;
  let api: Api;
  beforeAll(async () => {
    // A 1 s claim window and a 1.2 s session make a hold lapse in about 2 s.
    wrangler = await startPairing({
      DEMO_MAX_CONCURRENT: "2",
      CLAIM_TIMEOUT_SECONDS: "1",
      DEMO_SESSION_MINUTES: "0.02",
    });
    api = new Api(wrangler.url);
  });
  afterAll(() => wrangler?.stop());

  it("DEMO-02 cap: the third concurrent demo screen is refused, live screens are not, and a lapsed hold frees a slot", async () => {
    const from = (n: number) => ip(`203.0.113.${n}`);
    expect((await api.post("/api/screens", { mode: "demo" }, from(1))).status).toBe(201);
    expect((await api.post("/api/screens", { mode: "demo" }, from(2))).status).toBe(201);
    const full = await api.post("/api/screens", { mode: "demo" }, from(3));
    expect(full.status).toBe(429);
    expect(full.body).toEqual(problem(429, "rate_limited"));
    expect((await api.post("/api/screens", { mode: "live" }, from(3))).status).toBe(201);

    await sleep(2500);
    expect((await api.post("/api/screens", { mode: "demo" }, from(3))).status).toBe(201);
  });
});

describe("F14 DEMO-02 flood: one IP cannot fill the cap", () => {
  let wrangler: Wrangler;
  let api: Api;
  beforeAll(async () => {
    wrangler = await startPairing({ DEMO_MAX_PER_IP: "2" });
    api = new Api(wrangler.url);
  });
  afterAll(() => wrangler?.stop());

  it("DEMO-02 per-ip: a third concurrent demo screen from one IP is refused, another IP is served, and an ended session frees the slot", async () => {
    const mine = ip("198.51.100.7");
    const first = await api.post<{ sid: string }>("/api/screens", { mode: "demo" }, mine);
    expect(first.status).toBe(201);
    expect((await api.post("/api/screens", { mode: "demo" }, mine)).status).toBe(201);
    const refused = await api.post("/api/screens", { mode: "demo" }, mine);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual(problem(429, "rate_limited"));
    expect((await api.post("/api/screens", { mode: "demo" }, ip("198.51.100.8"))).status).toBe(201);

    // End the first screen's session: claim, approve, end. Its slot is released with the session.
    const state = await api.get<{ code: { code: string } }>("/api/screen/state", first.body.sid);
    const claimed = await claim(api, state.body.code.code);
    await api.get("/api/files", claimed.body.pid);
    expect((await api.post("/api/approve", { ids: ["demo-deck"] }, { auth: claimed.body.pid })).status).toBe(200);
    expect((await api.post("/api/end", {}, { auth: claimed.body.pid })).status).toBe(200);
    expect((await api.post("/api/screens", { mode: "demo" }, mine)).status).toBe(201);
  });

  it("DEMO-02 per-ip: a waiting screen ended by the screen closes at once and frees its slot", async () => {
    const mine = ip("198.51.100.9");
    const first = await api.post<{ sid: string }>("/api/screens", { mode: "demo" }, mine);
    expect((await api.post("/api/screens", { mode: "demo" }, mine)).status).toBe(201);
    expect((await api.post("/api/screens", { mode: "demo" }, mine)).status).toBe(429);

    // New Code on the screen: it ends the waiting screen before it creates the next one.
    const ended = await api.post<{ state: string; code: unknown }>("/api/screen/end", {}, { auth: first.body.sid });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ state: "closed", code: null });
    expect(ended.headers.get("Clear-Site-Data")).toBe('"storage"');
    expect((await api.post("/api/screens", { mode: "demo" }, mine)).status).toBe(201);
    // The object is gone: its sid now answers screen_gone.
    expect((await api.get("/api/screen/state", first.body.sid)).body).toMatchObject({ code: "screen_gone" });
  });
});
