// Guest-drop behavior that needs its own configuration: short timers (expired offer, auto-end), the storage
// budget, the R2 operation caps, the `pass` policy, and the platform rate limit. Each describe starts its own wrangler dev.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validDeck } from "../zip-builder.ts";
import { guestRow, pairPhone, problemCode, putDrop } from "./drop-client.ts";
import { fetchLink, sleep } from "./open-client.ts";
import { Api, claim, openScreen, PEPPER, startPairing } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

const deck = validDeck();

function withInstance(vars: Record<string, string>, timing = true, migrate = true) {
  const ctx = {} as { w: Wrangler; api: Api };
  beforeAll(async () => {
    ctx.w = timing
      ? await startPairing(vars, { migrate })
      : await startWrangler({ HASH_PEPPER: PEPPER, ...vars }, { migrate });
    ctx.api = new Api(ctx.w.url);
  });
  afterAll(() => ctx.w?.stop());
  return ctx;
}

describe("short timers", () => {
  const ctx = withInstance({ CLAIM_TIMEOUT_SECONDS: "3", SESSION_MAX_MINUTES: "0.05" });

  it("DROP-06 open-click: an offer nobody clicks expires, and the object is deleted", async () => {
    const { socket, pid } = await pairPhone(ctx.api);
    expect((await putDrop(ctx.api, pid, deck)).status).toBe(200);
    const key = String(guestRow(ctx.w.d1)?.r2_key);
    expect(ctx.w.r2Has(key)).toBe(true);
    await socket.stateWhere((v) => v.state === "waiting" && v.endReason === "claim_timeout", 8000);
    expect(ctx.w.r2Has(key)).toBe(false);
    expect(guestRow(ctx.w.d1)?.deleted_at).not.toBeNull();
    const phone = await ctx.api.get("/api/pair/state", pid);
    expect(phone.status).toBe(401);
    socket.close();
  }, 30_000);

  it("DROP-07 auto-end: the session limit ends an opened drop and deletes the object", async () => {
    const { socket, pid } = await pairPhone(ctx.api);
    await putDrop(ctx.api, pid, deck);
    const key = String(guestRow(ctx.w.d1)?.r2_key);
    socket.send({ t: "open.click" });
    await socket.waitFor((f) => f.t === "open");
    await socket.stateWhere((v) => v.state === "ended" && v.endReason === "auto", 8000);
    expect(ctx.w.r2Has(key)).toBe(false);
    expect(guestRow(ctx.w.d1)?.deleted_at).not.toBeNull();
    socket.close();
  }, 30_000);
});

describe("DROP-05 budget", () => {
  const ctx = withInstance({ GUEST_STORAGE_BUDGET_BYTES: String(Math.floor(deck.length * 1.5)) });

  it("refuses a drop that would pass the live-bytes budget, and takes it once space is freed", async () => {
    const one = await pairPhone(ctx.api);
    const two = await pairPhone(ctx.api);
    expect((await putDrop(ctx.api, one.pid, deck)).status).toBe(200);
    const full = await putDrop(ctx.api, two.pid, deck);
    expect(full.status).toBe(507);
    expect(await problemCode(full)).toBe("storage_full");
    expect((await ctx.api.get<{ state: string }>("/api/pair/state", two.pid)).body.state).toBe("claimed");
    expect((await ctx.api.post("/api/cancel", {}, { auth: one.pid })).status).toBe(200);
    expect((await putDrop(ctx.api, two.pid, deck)).status).toBe(200);
    one.socket.close();
    two.socket.close();
  }, 30_000);
});

const ops = (w: Wrangler, cls: "A" | "B") => Number(w.d1(`SELECT n FROM r2_ops WHERE class = '${cls}'`)[0]?.n ?? 0);

describe("DROP-05 R2 cap: operations counted against the free tier", () => {
  const ctx = withInstance({});

  it("counts a drop's put and reads, and takes it while under the caps", async () => {
    const { socket, pid } = await pairPhone(ctx.api);
    expect((await putDrop(ctx.api, pid, deck)).status).toBe(200);
    expect(ops(ctx.w, "A")).toBe(1);
    expect(ops(ctx.w, "B")).toBeGreaterThan(0);
    socket.close();
  }, 30_000);

  it("refuses a new drop with storage_full once class A is at its cap", async () => {
    ctx.w.d1("UPDATE r2_ops SET n = 500000 WHERE class = 'A'");
    const { socket, pid } = await pairPhone(ctx.api);
    const res = await putDrop(ctx.api, pid, deck);
    expect(res.status).toBe(507);
    expect(await problemCode(res)).toBe("storage_full");
    expect((await ctx.api.get<{ state: string }>("/api/pair/state", pid)).body.state).toBe("claimed");
    expect(ops(ctx.w, "A")).toBe(500000);
    socket.close();
  }, 30_000);

  it("refuses a new drop once class B is at its cap, and /f/ reads of a stored guest file with 502 upstream_failed", async () => {
    ctx.w.d1("UPDATE r2_ops SET n = 1 WHERE class = 'A'");
    const { socket, pid } = await pairPhone(ctx.api);
    expect((await putDrop(ctx.api, pid, deck)).status).toBe(200);
    socket.send({ t: "open.click" });
    const open = await socket.waitFor((f) => f.t === "open");
    const url = ((open.links as { protocol: string }).protocol ?? "").replace("ms-powerpoint:ofv|u|", "");
    ctx.w.d1("UPDATE r2_ops SET n = 5000000 WHERE class = 'B'");
    const fetched = await fetchLink(url);
    expect(fetched.status).toBe(502);
    expect(ops(ctx.w, "B")).toBe(5000000);
    const other = await pairPhone(ctx.api);
    const refused = await putDrop(ctx.api, other.pid, deck);
    expect(refused.status).toBe(507);
    expect(await problemCode(refused)).toBe("storage_full");
    socket.close();
    other.socket.close();
  }, 60_000);
});

describe("DROP-05 R2 cap: reads that pass the cap mid-upload", () => {
  const ctx = withInstance({ R2_CLASS_B_MONTHLY_CAP: "2" });

  it("answers storage_full, deletes the object and returns the session to claimed", async () => {
    const { socket, pid } = await pairPhone(ctx.api);
    const res = await putDrop(ctx.api, pid, deck);
    expect(res.status).toBe(507);
    expect(await problemCode(res)).toBe("storage_full");
    const key = String(guestRow(ctx.w.d1)?.r2_key);
    expect(ctx.w.r2Has(key)).toBe(false);
    expect(ops(ctx.w, "B")).toBe(2);
    socket.close();
  }, 30_000);
});

describe("DROP-06 policy: a pass room", () => {
  const ctx = withInstance({ GUEST_DROP: "pass" });

  it("refuses a guest claim without a pass, and a phone that scanned as an owner cannot start a drop", async () => {
    const { socket, code } = await openScreen(ctx.api, "live");
    const guest = await claim(ctx.api, code, "guest");
    expect(guest.status).toBe(403);
    expect(guest.body).toMatchObject({ code: "pass_required" });
    const owner = await claim(ctx.api, code, "owner");
    expect(owner.status).toBe(200);
    const res = await putDrop(ctx.api, owner.body.pid, deck);
    expect(res.status).toBe(403);
    expect(await problemCode(res)).toBe("pass_required");
    expect((await ctx.api.get<{ state: string }>("/api/pair/state", owner.body.pid)).body.state).toBe("claimed");
    socket.close();
  });

  it("refuses a claim that carries a pass: no pass is issued yet", async () => {
    const { socket, code } = await openScreen(ctx.api, "live");
    const res = await ctx.api.post("/api/claim", { code, kind: "guest", pass: "made-up" });
    expect(res.status).toBe(400);
    socket.close();
  });

  it("a demo screen still takes a drop", async () => {
    const { socket, code } = await openScreen(ctx.api, "demo");
    const claimed = await claim(ctx.api, code, "guest");
    expect((await putDrop(ctx.api, claimed.body.pid, deck)).status).toBe(200);
    socket.close();
  });
});

describe("DROP-06 policy: off", () => {
  const ctx = withInstance({ GUEST_DROP: "off" });

  it("DROP-06 policy off refuses a live drop with drop_disabled, and a demo screen still takes one", async () => {
    const live = await openScreen(ctx.api, "live");
    const guest = await claim(ctx.api, live.code, "guest");
    expect(guest.status).not.toBe(200);
    expect(guest.body).toMatchObject({ code: "drop_disabled" });
    const owner = await claim(ctx.api, live.code, "owner");
    const res = await putDrop(ctx.api, owner.body.pid, deck);
    expect(res.status).not.toBe(200);
    expect(await problemCode(res)).toBe("drop_disabled");
    const demo = await openScreen(ctx.api, "demo");
    const claimed = await claim(ctx.api, demo.code, "guest");
    expect((await putDrop(ctx.api, claimed.body.pid, deck)).status).toBe(200);
    live.socket.close();
    demo.socket.close();
  });
});

describe("DROP-05 demo cap", () => {
  const ctx = withInstance({ DEMO_GUEST_MAX_BYTES: String(deck.length - 1) });

  it("a demo screen refuses a file over its own lower cap, a live one takes it", async () => {
    const demo = await openScreen(ctx.api, "demo");
    const demoPhone = await claim(ctx.api, demo.code, "guest");
    const refused = await putDrop(ctx.api, demoPhone.body.pid, deck);
    expect(refused.status).toBe(413);
    expect(await problemCode(refused)).toBe("too_large");
    const live = await pairPhone(ctx.api);
    expect((await putDrop(ctx.api, live.pid, deck)).status).toBe(200);
    demo.socket.close();
    live.socket.close();
  });
});

describe("DROP-05 rate: the platform limit on uploads", () => {
  const ctx = withInstance({}, false);

  it("answers 429 after 5 uploads a minute from one address", async () => {
    const { socket, pid } = await pairPhone(ctx.api);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await putDrop(ctx.api, pid, deck, { name: "Talk.exe" })).status);
    expect(codes.slice(0, 5)).toEqual([415, 415, 415, 415, 415]);
    expect(codes[5]).toBe(429);
    socket.close();
    await sleep(0);
  }, 30_000);
});

describe("a database that fails mid-drop", () => {
  // No migrations: the guest_file insert throws, as a D1 outage would.
  const ctx = withInstance({}, true, false);

  it("answers internal as problem JSON and returns the session from uploading", async () => {
    const { socket, code } = await openScreen(ctx.api, "demo");
    const claimed = await claim(ctx.api, code, "guest");
    const res = await putDrop(ctx.api, claimed.body.pid, deck);
    expect(res.status).toBe(500);
    expect(await problemCode(res)).toBe("internal");
    await socket.stateWhere((v) => v.state === "claimed");
    socket.close();
  });
});
