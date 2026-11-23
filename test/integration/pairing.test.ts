import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, claim, openScreen, phoneSocket, rawUpgrade, Socket, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing();
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const problem = (code: string) => expect.objectContaining({ code });

describe("pairing: the whole flow over WebSockets", () => {
  it("PAIR flow: create, code over WS, claim, match code on both sides, approve, both see approved", async () => {
    const { screen, socket, code } = await openScreen(api);
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);

    const claimed = await claim(api, code);
    expect(claimed.status).toBe(200);
    expect(claimed.body.match).toMatch(/^\d{2}$/);
    expect(claimed.body.kind).toBe("owner");

    const onScreen = await socket.stateWhere((v) => v.state === "claimed");
    expect((onScreen.view as { match: string }).match).toBe(claimed.body.match);
    expect((onScreen.view as { code: unknown }).code).toBeNull();

    const phone = await phoneSocket(api, claimed.body.pid);
    const onPhone = await phone.stateWhere((v) => v.state === "claimed");
    expect((onPhone.view as { match: string }).match).toBe(claimed.body.match);

    const approved = await api.post("/api/approve", { fileId: "demo-deck" }, { auth: claimed.body.pid });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: "approved", fileName: "Sample deck.pptx" });
    for (const s of [socket, phone]) {
      const frame = await s.stateWhere((v) => v.state === "approved");
      expect((frame.view as { fileName: string }).fileName).toBe("Sample deck.pptx");
    }
    const view = (await onScreen).view as Record<string, unknown>;
    expect(Object.keys(view)).not.toContain("fileId");
    expect(screen.sid).not.toBe(claimed.body.pid);
    socket.close();
    phone.close();
  });

  it("PAIR-01 replay: a used code gives code_taken", async () => {
    const { socket, code } = await openScreen(api);
    expect((await claim(api, code)).status).toBe(200);
    const again = await claim(api, code);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ type: "about:blank", status: 409, code: "code_taken" });
    socket.close();
  });

  it("PAIR-05 second-phone: a second phone cannot claim, approve or end the locked session", async () => {
    const { socket, code } = await openScreen(api);
    const first = await claim(api, code);
    const second = await claim(api, code);
    expect(second.status).toBe(409);

    const other = await api.post(
      "/api/approve",
      { fileId: "demo-deck" },
      { auth: `${first.body.pid.split(".")[0]}.${"A".repeat(43)}` },
    );
    expect(other.status).toBe(401);
    expect(other.body).toEqual(problem("pairing_invalid"));
    const end = await api.post("/api/end", {}, { auth: `${first.body.pid.split(".")[0]}.${"B".repeat(43)}` });
    expect(end.status).toBe(401);

    const state = await api.get<{ state: string }>("/api/pair/state", first.body.pid);
    expect(state.body.state).toBe("claimed");
    socket.close();
  });

  it("PAIR-02 race: two phones claim one code at once, exactly one wins", async () => {
    const { socket, code } = await openScreen(api);
    const results = await Promise.all([claim(api, code), claim(api, code), claim(api, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    socket.close();
  });

  it("PAIR-02 Start Over: the screen drops the claim, shows a fresh code, and the old phone is cut off", async () => {
    const { screen, socket, code } = await openScreen(api);
    const claimed = await claim(api, code);
    const phone = await phoneSocket(api, claimed.body.pid);
    await socket.stateWhere((v) => v.state === "claimed");

    const restart = await api.post<{ state: string; code: { code: string } | null; endReason: string }>(
      "/api/screen/restart",
      {},
      { auth: screen.sid },
    );
    expect(restart.status).toBe(200);
    expect(restart.body.state).toBe("waiting");
    expect(restart.body.endReason).toBe("canceled");
    const fresh = restart.body.code?.code;
    expect(fresh).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(fresh).not.toBe(code);

    await socket.stateWhere((v) => v.state === "waiting" && (v.code as { code: string } | null)?.code === fresh);
    expect((await phone.waitFor((f) => f.t === "error")).code).toBe("pairing_invalid");
    expect((await phone.waitClosed()).code).toBe(1000);

    const stale = await api.get("/api/pair/state", claimed.body.pid);
    expect(stale.status).toBe(401);
    expect((await api.post("/api/approve", { fileId: "demo-deck" }, { auth: claimed.body.pid })).status).toBe(401);

    const old = await claim(api, code);
    expect(old.status).toBe(404);
    const next = await claim(api, fresh as string);
    expect(next.status).toBe(200);
    socket.close();
  });

  it("PAIR end from the phone: both sides see ended, repeat is idempotent, approve then answers session_ended", async () => {
    const { socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const phone = await phoneSocket(api, body.pid);
    await api.post("/api/approve", { fileId: "demo-deck" }, { auth: body.pid });

    const ended = await api.post<{ state: string; endReason: string }>("/api/end", {}, { auth: body.pid });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ state: "ended", endReason: "phone" });
    for (const s of [socket, phone]) {
      const frame = await s.stateWhere((v) => v.state === "ended");
      expect((frame.view as { endReason: string }).endReason).toBe("phone");
    }
    expect((await api.post("/api/end", {}, { auth: body.pid })).status).toBe(200);
    const late = await api.post("/api/approve", { fileId: "demo-deck" }, { auth: body.pid });
    expect(late.status).toBe(410);
    expect(late.body).toEqual(problem("session_ended"));
    socket.close();
    phone.close();
  });

  it("PAIR end from the screen: the phone sees ended and the response clears site data (RES-01)", async () => {
    const { screen, socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const phone = await phoneSocket(api, body.pid);
    await api.post("/api/approve", { fileId: "demo-deck" }, { auth: body.pid });

    const ended = await api.post<{ state: string; endReason: string }>("/api/screen/end", {}, { auth: screen.sid });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ state: "ended", endReason: "screen" });
    expect(ended.headers.get("Clear-Site-Data")).toBe('"storage"');
    const frame = await phone.stateWhere((v) => v.state === "ended");
    expect((frame.view as { endReason: string }).endReason).toBe("screen");
    socket.close();
    phone.close();
  });

  it("PAIR end from the phone before approval, and cancel returning the screen to waiting with a code", async () => {
    const { socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const cancel = await api.post<{ state: string; endReason: string }>("/api/cancel", {}, { auth: body.pid });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ state: "ended", endReason: "canceled" });
    const frame = await socket.stateWhere(
      (v) => v.state === "waiting" && v.code !== null && v.endReason === "canceled",
    );
    expect(frame.t).toBe("state");
    socket.close();
  });

  it("PAIR polling fallback: the whole flow with no WebSocket at all", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const sid = created.body.sid;
    const first = await api.get<{ state: string; code: { code: string } }>("/api/screen/state", sid);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe("waiting");
    const code = first.body.code.code;
    // A second poll inside the code's lifetime keeps the same code.
    expect((await api.get<{ code: { code: string } }>("/api/screen/state", sid)).body.code.code).toBe(code);

    const claimed = await claim(api, code);
    expect(claimed.status).toBe(200);
    const screenView = await api.get<{ state: string; match: string }>("/api/screen/state", sid);
    expect(screenView.body).toMatchObject({ state: "claimed", match: claimed.body.match });
    const phoneView = await api.get<{ state: string; match: string }>("/api/pair/state", claimed.body.pid);
    expect(phoneView.body).toMatchObject({ state: "claimed", match: claimed.body.match });

    await api.post("/api/approve", { fileId: "demo-deck" }, { auth: claimed.body.pid });
    expect((await api.get<{ state: string }>("/api/screen/state", sid)).body.state).toBe("approved");
    await api.post("/api/screen/end", {}, { auth: sid });
    expect((await api.get<{ state: string }>("/api/pair/state", claimed.body.pid)).body.state).toBe("ended");
  });

  it("PAIR-08 ids: the screen and the phone credentials are not interchangeable", async () => {
    const { screen, socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    expect((await api.get("/api/pair/state", screen.sid)).status).toBe(401);
    expect((await api.get("/api/screen/state", body.pid)).status).toBe(401);
    expect((await api.post("/api/screen/end", {}, { auth: body.pid })).status).toBe(401);
    expect((await api.post("/api/end", {}, { auth: screen.sid })).status).toBe(401);
    expect((await api.get("/api/screen/state")).status).toBe(401);
    expect((await api.get("/api/screen/state", "not-a-credential")).status).toBe(401);
    socket.close();
  });

  it("PAIR-08 ids: a screen that never existed answers screen_gone", async () => {
    const ghost = `${"A".repeat(22)}.${"B".repeat(43)}`;
    const res = await api.get("/api/screen/state", ghost);
    expect(res.status).toBe(410);
    expect(res.body).toEqual(problem("screen_gone"));
  });
});

describe("pairing: validation at every boundary", () => {
  it("rejects malformed bodies with 400 and a problem+json code", async () => {
    expect((await api.post("/api/screens", { mode: "weird" })).status).toBe(400);
    expect((await api.post("/api/screens", {})).status).toBe(400);
    expect((await api.post("/api/screens", { mode: "demo", extra: true })).status).toBe(400);
    expect((await api.post("/api/claim", { code: 123 })).status).toBe(400);
    expect((await api.post("/api/claim", { code: "ABCDEF", unknown: 1 })).status).toBe(400);
    expect((await api.post("/api/claim", undefined, { raw: "{not json" })).status).toBe(400);
    expect(
      (await api.post("/api/approve", { fileId: "" }, { auth: `${"A".repeat(22)}.${"B".repeat(43)}` })).status,
    ).toBe(400);
  });

  it("answers code_malformed for a code that cannot exist, without touching the Directory", async () => {
    for (const code of ["", "ABC", "ABCDEF0", "OOOOOO", "ABC DE!"]) {
      const res = await api.post("/api/claim", { code });
      expect(res.status, code).toBe(400);
      expect(res.body, code).toEqual(problem("code_malformed"));
    }
  });

  it("accepts a code typed with lowercase, spaces and dashes", async () => {
    const { socket, code } = await openScreen(api);
    const typed = `${code.slice(0, 3)} - ${code.slice(3)}`.toLowerCase();
    expect((await api.post("/api/claim", { code: typed })).status).toBe(200);
    socket.close();
  });

  it("refuses a guest pass until passes exist, and a live approve of a file nobody listed (SRC-02)", async () => {
    const live = await openScreen(api, "live");
    const pass = await api.post("/api/claim", { code: live.code, pass: "whatever", kind: "guest" });
    expect(pass.body).toEqual(problem("pass_invalid"));
    const claimed = await claim(api, live.code);
    // FILE_SOURCE=mock: the demo account is the user, so there is nothing to sign in to.
    expect(claimed.body.needsAuth).toBe(false);
    const approve = await api.post("/api/approve", { fileId: "demo-deck" }, { auth: claimed.body.pid });
    expect(approve.status).toBe(404);
    expect(approve.body).toEqual(problem("file_not_found"));
    live.socket.close();
  });

  it("a demo guest can claim but cannot approve or list: guests have no account", async () => {
    const { socket, code } = await openScreen(api);
    const guest = await claim(api, code, "guest");
    expect(guest.body).toMatchObject({ kind: "guest", needsAuth: false });
    const approve = await api.post("/api/approve", { fileId: "demo-deck" }, { auth: guest.body.pid });
    expect(approve.status).toBe(409);
    expect(approve.body).toEqual(problem("wrong_state"));
    expect((await api.get("/api/files", guest.body.pid)).body).toEqual(problem("wrong_state"));
    socket.close();
  });

  it("serves the API method table: GET on a POST route is 405 with Allow", async () => {
    const res = await fetch(`${wrangler.url}/api/claim`);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

describe("PAIR-06 csrf: cross-origin and non-JSON writes are refused and change nothing", () => {
  it("PAIR-06 csrf: a cross-origin POST to approve is rejected", async () => {
    const { socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    for (const origin of ["https://evil.example", "null", null]) {
      const res = await api.post("/api/approve", { fileId: "demo-deck" }, { auth: body.pid, origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.body).toEqual(problem("forbidden_origin"));
    }
    const sameSite = await api.post(
      "/api/approve",
      { fileId: "demo-deck" },
      {
        auth: body.pid,
        headers: { "Sec-Fetch-Site": "cross-site" },
      },
    );
    expect(sameSite.status).toBe(403);
    const state = await api.get<{ state: string }>("/api/pair/state", body.pid);
    expect(state.body.state).toBe("claimed");
    socket.close();
  });

  it("PAIR-06 csrf: a cross-origin POST to end, cancel, restart and screen end is rejected", async () => {
    const { screen, socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const evil = { origin: "https://evil.example" };
    expect((await api.post("/api/end", {}, { auth: body.pid, ...evil })).status).toBe(403);
    expect((await api.post("/api/cancel", {}, { auth: body.pid, ...evil })).status).toBe(403);
    expect((await api.post("/api/screen/restart", {}, { auth: screen.sid, ...evil })).status).toBe(403);
    expect((await api.post("/api/screen/end", {}, { auth: screen.sid, ...evil })).status).toBe(403);
    expect((await api.post("/api/claim", { code }, evil)).status).toBe(403);
    expect((await api.post("/api/screens", { mode: "demo" }, evil)).status).toBe(403);
    const state = await api.get<{ state: string }>("/api/screen/state", screen.sid);
    expect(state.body.state).toBe("claimed");
    socket.close();
  });

  it("PAIR-06 csrf: a form-encoded post gets 415 and a missing credential gets 401", async () => {
    const { socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const form = await api.post("/api/approve", undefined, {
      auth: body.pid,
      contentType: "application/x-www-form-urlencoded",
      raw: "fileId=demo-deck",
    });
    expect(form.status).toBe(415);
    const text = await api.post("/api/end", undefined, { auth: body.pid, contentType: "text/plain", raw: "{}" });
    expect(text.status).toBe(415);
    const none = await api.post("/api/approve", { fileId: "demo-deck" });
    expect(none.status).toBe(401);
    expect((await api.get<{ state: string }>("/api/pair/state", body.pid)).body.state).toBe("claimed");
    socket.close();
  });
});

describe("PAIR-10 ws-origin and the socket protocol", () => {
  it("PAIR-10 ws-origin: an upgrade from another origin or with none is refused", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const ref = created.body.sid.split(".")[0];
    await expect(Socket.open(api.base, `/api/screen/ws?ref=${ref}`, "https://evil.example")).rejects.toThrow();
    await expect(Socket.open(api.base, `/api/screen/ws?ref=${ref}`, null)).rejects.toThrow();
    const ws = (path: string, headers: Record<string, string>) => rawUpgrade(api.base, path, headers);
    expect(await ws(`/api/screen/ws?ref=${ref}`, { Origin: "https://evil.example" })).toBe(403);
    expect(await ws(`/api/screen/ws?ref=${ref}`, {})).toBe(403);
    expect(await ws(`/api/pair/ws?ref=${ref}`, { Origin: "https://evil.example" })).toBe(403);
    expect(await ws("/api/screen/ws?ref=short", { Origin: api.base })).toBe(400);
    const plain = await fetch(`${api.base}/api/screen/ws?ref=${ref}`, { headers: { Origin: api.base } });
    expect(plain.status).toBe(400);
  });

  it("PAIR-10 ws-origin: a bad hello gets an error frame and a 1008 close", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const ref = created.body.sid.split(".")[0];
    const socket = await Socket.open(api.base, `/api/screen/ws?ref=${ref}`);
    socket.send({ t: "hello", sid: `${ref}.${"A".repeat(43)}` });
    expect((await socket.waitFor((f) => f.t === "error")).code).toBe("unauthorized");
    expect((await socket.waitClosed()).code).toBe(1008);
  });

  it("closes 1008 on an unknown type, a frame before hello, bad JSON and an oversized frame", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const ref = created.body.sid.split(".")[0];
    const attempts: (Record<string, unknown> | string)[] = [
      { t: "state" },
      { t: "code.next" },
      "{not json",
      JSON.stringify({ v: 1, t: "hello", sid: "x".repeat(5000) }),
    ];
    for (const frame of attempts) {
      const socket = await Socket.open(api.base, `/api/screen/ws?ref=${ref}`);
      socket.send(frame);
      expect((await socket.waitClosed()).code, String(frame).slice(0, 20)).toBe(1008);
    }
  });

  it("answers the exact ping string with the exact pong string", async () => {
    const { socket } = await openScreen(api);
    socket.send('{"v":1,"t":"ping"}');
    expect((await socket.waitFor((f) => f.t === "pong")).t).toBe("pong");
    socket.send({ t: "ping" });
    socket.close();
  });

  it("PAIR-11 screen-events: a screen cannot launch, fetch or open-click out of order", async () => {
    const { socket, code } = await openScreen(api);
    socket.send({ t: "launched", mode: "protocol" });
    expect((await socket.waitFor((f) => f.t === "error")).code).toBe("wrong_state");
    const claimed = await claim(api, code);
    await socket.stateWhere((v) => v.state === "claimed");
    const frames = socket.frames.length;
    socket.send({ t: "open.click" });
    await socket.waitFor((f) => f.t === "error" && socket.frames.length > frames);
    const state = await api.get<{ state: string }>("/api/pair/state", claimed.body.pid);
    expect(state.body.state).toBe("claimed");
    socket.close();
  });

  it("a phone socket cannot send screen frames", async () => {
    const { socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const phone = await phoneSocket(api, body.pid);
    phone.send({ t: "open.click" });
    expect((await phone.waitClosed()).code).toBe(1008);
    socket.close();
  });

  it("a code requested over the socket replaces the shown one and keeps the old one claimable for its grace", async () => {
    const { socket, code } = await openScreen(api);
    socket.send({ t: "code.next" });
    const next = await socket.stateWhere((v) => (v.code as { code: string } | null)?.code !== code && v.code !== null);
    const fresh = (next.view as { code: { code: string } }).code.code;
    expect(fresh).not.toBe(code);
    expect((await claim(api, code)).status).toBe(200);
    socket.close();
  });
});

describe("SITE-03 logs: the captured output holds no credential, code or pairing secret", () => {
  it("SITE-03 logs: nothing sensitive reached the Worker log during the run above", async () => {
    const { screen, socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    await api.post("/api/approve", { fileId: "demo-deck" }, { auth: body.pid });
    const secrets = [screen.sid, body.pid, screen.sid.split(".")[1], body.pid.split(".")[1], code];
    const out = wrangler.output();
    for (const secret of secrets) expect(out).not.toContain(secret as string);
    expect(out).not.toContain("fake-test-pepper");
    socket.close();
  });
});
