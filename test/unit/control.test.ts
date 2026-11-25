import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Shown } from "../../src/shared/protocol.ts";
import { fileById, itemId, pageCount, withIds } from "../../src/worker/items.ts";
import { type Machine, type Sender, transition } from "../../src/worker/machine.ts";
import { PROD_VARS } from "../env-vars.ts";
import {
  asItem,
  CFG,
  claimedOwner,
  DECK,
  ended,
  fx,
  MAX_MINUTES,
  must,
  offered,
  sec,
  T0,
  VEVOX,
} from "./machine-helpers.ts";

const DOG = { source: "mock", ref: "dog-1", name: "Dog.jpg", type: "jpg" } as const;
const at = T0 + sec(30);
let clock = 0;
/** A control event; each call gets a newer seq unless one is given. */
const command = (shown: Shown, seq = ++clock, from: Sender = "phone") =>
  ({ e: "control", now: at, from, seq, shown }) as const;
const deckPage = (page: number, present = false): Shown => ({ item: "i1", page, present });

/** A demo session holding a deck (i1), a photo (i2) and a link (i3). */
const list = (): Machine =>
  must(claimedOwner(), {
    e: "approve",
    now: T0 + sec(10),
    items: [VEVOX, asItem(DECK), asItem(DOG)],
    minutes: MAX_MINUTES,
  }).next;

const refused = (m: Machine, shown: Shown) => {
  const step = transition(m, command(shown), CFG);
  return step.ok ? null : step.error;
};

describe("PAIR-13 item ids: server-assigned at approval, unique, never an index", () => {
  it("gives each approved item an id in the sorted order, and keeps it for the session", () => {
    const m = list();
    expect(m.session?.items.map((i) => [i.id, i.ref])).toEqual([
      ["i1", "deck-1"],
      ["i2", "dog-1"],
      ["i3", "demo-vevox"],
    ]);
    const open = must(must(m, { e: "launched", now: at, mode: "protocol" }).next, { e: "fetched", now: at });
    expect(open.next.session?.items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
  });

  it("an approve replayed with the same items changes nothing, so ids are not reissued", () => {
    const m = list();
    const again = must(m, { e: "approve", now: at, items: [asItem(DOG), VEVOX, asItem(DECK)], minutes: 1 });
    expect(again.next).toBe(m);
  });

  it("a guest's offered file already has its id, and approval keeps it", () => {
    expect(offered().session?.items.map((i) => i.id)).toEqual(["i1"]);
    const open = must(offered(), { e: "open.click", now: at, minutes: MAX_MINUTES }).next;
    expect(open.session?.items.map((i) => i.id)).toEqual(["i1"]);
  });

  it("withIds keeps the ids a stored list holds, whatever its order, and numbers a list missing any id whole", () => {
    const [deck, dog, link] = withIds([asItem(DECK), asItem(DOG), VEVOX]);
    if (!deck || !dog || !link) throw new Error("fixture");
    expect(withIds([link, deck, dog]).map((i) => i.id)).toEqual(["i3", "i1", "i2"]);
    expect(withIds([link, asItem(DECK)]).map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it("looks a file up by id, and a link or an unknown id is no file", () => {
    const items = withIds([asItem(DECK), VEVOX]);
    expect(fileById(items, itemId(0))?.ref).toBe("deck-1");
    expect(fileById(items, itemId(1))).toBeNull();
    expect(fileById(items, "nope")).toBeNull();
  });
});

describe("PAIR-13 control: only the pairing's phone commands the screen, absolute, files only", () => {
  it("is allowed in approved, opening and open, and stores what the screen shows", () => {
    const approvedList = list();
    const opening = must(approvedList, { e: "launched", now: at, mode: "protocol" }).next;
    const open = must(opening, { e: "fetched", now: at }).next;
    for (const m of [approvedList, opening, open]) {
      const step = must(m, command(deckPage(2, true)));
      expect(step.next.state).toBe(m.state);
      expect(step.next.session?.shown).toEqual({ item: "i1", page: 2, present: true });
      expect(fx(step.effects, "push")).toEqual([{ fx: "push", to: "both" }]);
    }
  });

  it("PAIR-13 replay: the same command again is a no-op: the same machine, no effect, nothing pushed", () => {
    const first = must(list(), command(deckPage(2), 5)).next;
    const again = must(first, command(deckPage(2), 5));
    expect(again.next).toBe(first);
    expect(again.effects).toEqual([]);
  });

  it("PAIR-13 replay: the same `shown` under a newer seq takes the seq and pushes nothing", () => {
    const first = must(list(), command(deckPage(2), 5)).next;
    const again = must(first, command(deckPage(2), 6));
    expect(again.next.session?.seq.phone).toBe(6);
    expect(again.effects).toEqual([]);
  });

  it("a newer command replaces the last one", () => {
    const one = must(list(), command(deckPage(2))).next;
    const two = must(one, command({ item: "i2", page: 1, present: true })).next;
    expect(two.session?.shown).toEqual({ item: "i2", page: 1, present: true });
    expect(must(two, command(deckPage(1))).next.session?.shown).toEqual(deckPage(1));
  });

  it("PAIR-13 order: an older command from the same sender that arrives late changes nothing", () => {
    const pageOne = must(list(), command(deckPage(1), 20)).next;
    const late = must(pageOne, command(deckPage(2), 19));
    expect(late.next).toBe(pageOne);
    expect(late.effects).toEqual([]);
    expect(late.next.session?.shown).toEqual(deckPage(1));
  });

  it("PAIR-13 order: each sender has its own seq, and between the phone and the screen the last applied wins", () => {
    const phone = must(list(), command(deckPage(2), 1000)).next;
    // The screen's clock is behind the phone's: its tap still applies, since its seq is its own.
    const screen = must(phone, command(deckPage(1), 3, "screen")).next;
    expect(screen.session?.shown).toEqual(deckPage(1));
    expect(screen.session?.seq).toEqual({ phone: 1000, screen: 3 });
    const phoneAgain = must(screen, command({ item: "i2", page: 1, present: false }, 1001)).next;
    expect(phoneAgain.session?.shown?.item).toBe("i2");
    expect(must(phoneAgain, command(deckPage(2), 2, "screen")).next).toBe(phoneAgain);
  });

  it("a new session starts every sender's seq again", () => {
    expect(list().session?.seq).toEqual({ phone: 0, screen: 0 });
    expect(offered().session?.seq).toEqual({ phone: 0, screen: 0 });
  });

  it("refuses wrong_state before approval, after the end, and in a live session", () => {
    expect(refused(claimedOwner(), deckPage(1))).toBe("wrong_state");
    expect(refused(offered(), deckPage(1))).toBe("wrong_state");
    expect(refused(ended(), deckPage(1))).toBe("wrong_state");
    const live = must(must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1"] }).next, {
      e: "approve",
      now: T0 + sec(5),
      items: [asItem(DECK)],
      minutes: MAX_MINUTES,
    }).next;
    expect(refused(live, deckPage(1))).toBe("wrong_state");
  });

  it("LINK-01 a link is never remote-opened: file_not_found, and nothing is stored", () => {
    const m = list();
    expect(refused(m, { item: "i3", page: 1, present: false })).toBe("file_not_found");
    expect(m.session?.shown).toBeNull();
  });

  it("PAIR-11 an id outside the list is file_not_found, and so is an index", () => {
    expect(refused(list(), { item: "i9", page: 1, present: false })).toBe("file_not_found");
    expect(refused(list(), { item: "0", page: 1, present: false })).toBe("file_not_found");
    expect(refused(list(), { item: "deck-1", page: 1, present: false })).toBe("file_not_found");
  });

  it("refuses a page outside the item's pages: the demo deck has two, a photo or a guest file one", () => {
    expect(refused(list(), deckPage(3))).toBe("bad_request");
    expect(refused(list(), deckPage(0))).toBe("bad_request");
    expect(refused(list(), deckPage(1.5))).toBe("bad_request");
    expect(refused(list(), { item: "i2", page: 2, present: false })).toBe("bad_request");
    expect(must(list(), command({ item: "i2", page: 1, present: false })).next.session?.shown?.item).toBe("i2");
    const guest = must(offered(), { e: "open.click", now: at, minutes: MAX_MINUTES }).next;
    expect(refused(guest, deckPage(2))).toBe("bad_request");
  });

  it("counts a demo owner's deck and PDF as the pre-rendered pages and everything else as one", () => {
    const [deck, dog] = list().session?.items ?? [];
    if (deck?.kind !== "file" || dog?.kind !== "file") throw new Error("fixture");
    expect(pageCount(deck, { mode: "demo", kind: "owner" })).toBe(2);
    expect(pageCount(deck, { mode: "demo", kind: "guest" })).toBe(1);
    expect(pageCount(dog, { mode: "demo", kind: "owner" })).toBe(1);
  });

  it("an ended session keeps no `shown`", () => {
    const shown = must(list(), command(deckPage(2))).next;
    const over = must(shown, { e: "end", now: at, by: "phone" }).next;
    expect(over.session).toBeNull();
  });
});

describe("PAIR-13 rate limits: RL_CONTROL per IP, then per credential", () => {
  const ORIGIN = "http://127.0.0.1:8787";
  const REF = "S".repeat(22);
  const PID = `${REF}.${"p".repeat(43)}`;
  const PID_HASH = createHash("sha256").update(PID).digest("hex");
  /** A Worker env whose rate limit and Screen object record the order they are called in. */
  function env(limitCredential: boolean) {
    const calls: string[] = [];
    const RL_CONTROL = {
      limit: async ({ key }: { key: string }) => {
        const kind = key === PID_HASH ? "credential" : key === REF ? "ref" : "ip";
        calls.push(`limit:${kind}`);
        return { success: !(limitCredential && kind === "credential") };
      },
    };
    // `/f/`'s binding, spent by a video's range reads behind the same address: always out of budget here.
    const RL_FETCH = {
      limit: async () => {
        calls.push("limit:fetch");
        return { success: false };
      },
    };
    const call = (name: string) => async () => {
      calls.push(name);
      return { ok: true, value: { shown: null } };
    };
    const stub = { control: call("control"), setLength: call("setLength") };
    const SCREEN = { idFromName: (n: string) => n, get: () => stub };
    return { calls, env: { ...PROD_VARS, PUBLIC_ORIGIN: ORIGIN, RL_CONTROL, RL_FETCH, SCREEN } };
  }
  type PostRoute = {
    pattern: URLPattern;
    handler: (r: Request, env: object, m: URLPatternResult) => Promise<Response>;
  };
  const post = async (e: object, url = "/api/control", body: unknown = { ...deckPage(1), seq: 1 }) => {
    // A non-literal specifier: the route's type graph needs the Workers types, which the test tsconfig leaves out.
    const path = "../../src/worker/routes/control.ts";
    const routes = (await import(path)) as { controlRoutes: readonly PostRoute[] };
    const request = new Request(`${ORIGIN}${url}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${PID}` },
      body: JSON.stringify(body),
    });
    const route = routes.controlRoutes.find((r) => r.pattern.test(request.url)) as PostRoute;
    return route.handler(request, e, route.pattern.exec(request.url) as URLPatternResult);
  };
  const setLength = (e: object, minutes: unknown) => post(e, "/api/session/length", { minutes });

  it("SESS-01 rate limit: a length change spends RL_CONTROL per IP, then per credential, never RL_FETCH", async () => {
    const { calls, env: e } = env(false);
    expect((await setLength(e, 30)).status).toBe(200);
    expect(calls).toEqual(["limit:ip", "limit:credential", "setLength"]);
    const spent = env(true);
    expect((await setLength(spent.env, 30)).status).toBe(429);
    expect(spent.calls).toEqual(["limit:ip", "limit:credential"]);
  });

  it("SESS-01 schema: minutes is a whole number from 5 to the live cap, alone; anything else reaches no Screen object", async () => {
    // PROD_VARS caps a live session at 90 minutes.
    for (const minutes of [5, 90]) expect((await setLength(env(false).env, minutes)).status, String(minutes)).toBe(200);
    for (const minutes of [4, 91, 30.5, "30", null, -1]) {
      const { calls, env: e } = env(false);
      const res = await setLength(e, minutes);
      expect(res.status, String(minutes)).toBe(400);
      expect(calls, String(minutes)).toEqual([]);
    }
    const extra = env(false);
    expect((await post(extra.env, "/api/session/length", { minutes: 30, endsAt: 1 })).status).toBe(400);
    expect(extra.calls).toEqual([]);
  });

  it("PAIR-13 rate limit: a command spends the IP's budget, then its credential's (by hash, never the screen ref)", async () => {
    const { calls, env: e } = env(false);
    expect((await post(e)).status).toBe(200);
    expect(calls).toEqual(["limit:ip", "limit:credential", "control"]);
  });

  it("PAIR-13 rate limit: a spent /f/ budget (a video's range reads on the same IP) never refuses a tap", async () => {
    const { calls, env: e } = env(false);
    expect((await post(e)).status).toBe(200);
    expect(calls).not.toContain("limit:fetch");
  });

  it("PAIR-13 rate limit: a spent credential budget is a 429 that reaches no Screen object", async () => {
    const { calls, env: e } = env(true);
    const res = await post(e);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "rate_limited" }));
    expect(calls).toEqual(["limit:ip", "limit:credential"]);
  });
});
