// Timers with the test-only short timings. TEST_TIMING=1 lowers the config floors and is refused unless
// PUBLIC_ORIGIN is a local address; production never sets it (docs/architecture.md section 11).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, claim, openScreen, phoneSocket, silentSocketOutcome, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing({
    CODE_TTL_SECONDS: "2",
    CODE_GRACE_SECONDS: "1",
    CLAIM_TIMEOUT_SECONDS: "3",
    SESSION_MAX_MINUTES: "0.05",
    DEMO_SESSION_MINUTES: "0.05",
  });
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const problem = (code: string) => expect.objectContaining({ code });

describe("code lifetime", () => {
  it("PAIR-01 expiry: a code claims inside ttl plus grace and gives code_expired after", async () => {
    const early = await openScreen(api);
    await sleep(2300); // past the 2 s ttl, inside the 1 s grace: still the only code, still claimable
    expect((await claim(api, early.code)).status).toBe(200);
    early.socket.close();

    const late = await openScreen(api);
    await sleep(3300); // past ttl plus grace
    const res = await claim(api, late.code);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ type: "about:blank", status: 410, code: "code_expired" });
    late.socket.close();
  });

  it("PAIR-01 expiry: after rotation the previous code works for the grace and not beyond", async () => {
    const quick = await openScreen(api);
    quick.socket.send({ t: "code.next" });
    await quick.socket.stateWhere((v) => v.code !== null && (v.code as { code: string }).code !== quick.code);
    expect((await claim(api, quick.code)).status).toBe(200); // inside the grace after its successor
    quick.socket.close();

    const slow = await openScreen(api);
    slow.socket.send({ t: "code.next" });
    const next = await slow.socket.stateWhere(
      (v) => v.code !== null && (v.code as { code: string }).code !== slow.code,
    );
    const fresh = (next.view as { code: { code: string } }).code.code;
    await sleep(1300); // the grace (1 s) is over; the old code's own ttl plus grace (3 s) is not
    expect((await claim(api, slow.code)).body).toEqual(problem("code_expired"));
    expect((await claim(api, fresh)).status).toBe(200);
    slow.socket.close();
  });

  it("PAIR polling fallback: a poll after the ttl rotates the code, and the old code still has its grace", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const sid = created.body.sid;
    const first = (await api.get<{ code: { code: string } }>("/api/screen/state", sid)).body.code.code;
    await sleep(2100);
    const second = (await api.get<{ code: { code: string } }>("/api/screen/state", sid)).body.code.code;
    expect(second).not.toBe(first);
    expect((await claim(api, first)).status).toBe(200);
  });
});

describe("session timers", () => {
  it("PAIR claim timeout: an unapproved claim drops back to waiting with a fresh code and cuts the phone off", async () => {
    const { socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const phone = await phoneSocket(api, body.pid);
    const back = await socket.stateWhere(
      (v) => v.state === "waiting" && v.endReason === "claim_timeout" && v.code !== null,
      8000,
    );
    expect((back.view as { code: { code: string } }).code.code).not.toBe(code);
    expect((await phone.waitFor((f) => f.t === "error")).code).toBe("pairing_invalid");
    expect((await phone.waitClosed()).code).toBe(1000);
    expect((await api.get("/api/pair/state", body.pid)).status).toBe(401);
    socket.close();
  });

  it("PC-04 auto-end: an approved session ends by itself, on both sockets and by polling", async () => {
    const { screen, socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    const phone = await phoneSocket(api, body.pid);
    const approved = await api.post<{ endsAt: number }>("/api/approve", { fileId: "demo-deck" }, { auth: body.pid });
    expect(approved.body.endsAt).toBeLessThan(Date.now() + 4000);
    for (const s of [socket, phone]) {
      const frame = await s.stateWhere((v) => v.state === "ended", 8000);
      expect((frame.view as { endReason: string }).endReason).toBe("auto");
    }
    const polled = await api.get<{ state: string; endReason: string }>("/api/pair/state", body.pid);
    expect(polled.body).toMatchObject({ state: "ended", endReason: "auto" });
    expect((await api.post("/api/approve", { fileId: "demo-deck" }, { auth: body.pid })).status).toBe(410);
    expect((await api.get<{ state: string }>("/api/screen/state", screen.sid)).body.state).toBe("ended");
    socket.close();
    phone.close();
  });

  it("PAIR end then a new code: refused for 3 s, then the screen is waiting again with a code", async () => {
    const { screen, socket, code } = await openScreen(api);
    const { body } = await claim(api, code);
    await api.post("/api/end", {}, { auth: body.pid });
    await socket.stateWhere((v) => v.state === "ended");
    socket.send({ t: "code.next" });
    expect((await socket.waitFor((f) => f.t === "error")).code).toBe("rate_limited");
    await sleep(3100);
    socket.send({ t: "code.next" });
    const waiting = await socket.stateWhere((v) => v.state === "waiting" && v.code !== null && v.endReason === null);
    expect((waiting.view as { code: unknown }).code).not.toBeNull();
    expect((await api.get("/api/pair/state", body.pid)).status).toBe(401);
    expect(screen.sid).toBeTruthy();
    socket.close();
  });

  it("a screen socket that sends no frame at all gets an error frame, then close 1008 after 5 s", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const ref = created.body.sid.split(".")[0];
    const started = Date.now();
    const { texts, close } = await silentSocketOutcome(api.base, `/api/screen/ws?ref=${ref}`, 9000);
    expect(close).toEqual({ code: 1008, reason: "hello timeout" });
    expect(Date.now() - started).toBeGreaterThan(4000);
    expect(texts.map((t) => JSON.parse(t))).toEqual([expect.objectContaining({ t: "error", code: "unauthorized" })]);
  });
});
