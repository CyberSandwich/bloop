import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Shown } from "../../src/shared/protocol.ts";
import { fileById, itemId, pageCount, withIds } from "../../src/worker/items.ts";
import { type Machine, transition } from "../../src/worker/machine.ts";
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
const command = (shown: Shown, now = at) => ({ e: "control", now, shown }) as const;
const deckPage = (page: number, present = false): Shown => ({ item: "i1", page, present });

/** A demo session holding a deck (i1), a photo (i2) and a link (i3). */
const list = (): Machine =>
  must(claimedOwner(), {
    e: "approve",
    now: T0 + sec(10),
    items: [VEVOX, asItem(DECK), asItem(DOG)],
    maxMinutes: MAX_MINUTES,
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
    const again = must(m, { e: "approve", now: at, items: [asItem(DOG), VEVOX, asItem(DECK)], maxMinutes: 1 });
    expect(again.next).toBe(m);
  });

  it("a guest's offered file already has its id, and approval keeps it", () => {
    expect(offered().session?.items.map((i) => i.id)).toEqual(["i1"]);
    const open = must(offered(), { e: "open.click", now: at, maxMinutes: MAX_MINUTES }).next;
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

  it("a replay is a no-op: the same machine, no effect, nothing pushed", () => {
    const first = must(list(), command(deckPage(2))).next;
    const again = must(first, command(deckPage(2), at + sec(1)));
    expect(again.next).toBe(first);
    expect(again.effects).toEqual([]);
  });

  it("a different command replaces the last one, whatever order they arrive in", () => {
    const one = must(list(), command(deckPage(2))).next;
    const two = must(one, command({ item: "i2", page: 1, present: true })).next;
    expect(two.session?.shown).toEqual({ item: "i2", page: 1, present: true });
    expect(must(two, command(deckPage(1))).next.session?.shown).toEqual(deckPage(1));
  });

  it("refuses wrong_state before approval, after the end, and in a live session", () => {
    expect(refused(claimedOwner(), deckPage(1))).toBe("wrong_state");
    expect(refused(offered(), deckPage(1))).toBe("wrong_state");
    expect(refused(ended(), deckPage(1))).toBe("wrong_state");
    const live = must(must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1"] }).next, {
      e: "approve",
      now: T0 + sec(5),
      items: [asItem(DECK)],
      maxMinutes: MAX_MINUTES,
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
    const guest = must(offered(), { e: "open.click", now: at, maxMinutes: MAX_MINUTES }).next;
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

describe("PAIR-13 rate limits: RL_FETCH per IP, then per credential", () => {
  const ORIGIN = "http://127.0.0.1:8787";
  const REF = "S".repeat(22);
  const PID = `${REF}.${"p".repeat(43)}`;
  const PID_HASH = createHash("sha256").update(PID).digest("hex");
  /** A Worker env whose rate limit and Screen object record the order they are called in. */
  function env(limitCredential: boolean) {
    const calls: string[] = [];
    const RL_FETCH = {
      limit: async ({ key }: { key: string }) => {
        const kind = key === PID_HASH ? "credential" : key === REF ? "ref" : "ip";
        calls.push(`limit:${kind}`);
        return { success: !(limitCredential && kind === "credential") };
      },
    };
    const control = async () => {
      calls.push("control");
      return { ok: true, value: { shown: null } };
    };
    const SCREEN = { idFromName: (n: string) => n, get: () => ({ control }) };
    return { calls, env: { ...PROD_VARS, PUBLIC_ORIGIN: ORIGIN, RL_FETCH, SCREEN } };
  }
  type PostRoute = {
    pattern: URLPattern;
    handler: (r: Request, env: object, m: URLPatternResult) => Promise<Response>;
  };
  const post = async (e: object) => {
    // A non-literal specifier: the route's type graph needs the Workers types, which the test tsconfig leaves out.
    const path = "../../src/worker/routes/control.ts";
    const route = ((await import(path)) as { controlRoutes: readonly PostRoute[] }).controlRoutes[0] as PostRoute;
    const request = new Request(`${ORIGIN}/api/control`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${PID}` },
      body: JSON.stringify(deckPage(1)),
    });
    return route.handler(request, e, route.pattern.exec(request.url) as URLPatternResult);
  };

  it("PAIR-13 rate limit: a command spends the IP's budget, then its credential's (by hash, never the screen ref)", async () => {
    const { calls, env: e } = env(false);
    expect((await post(e)).status).toBe(200);
    expect(calls).toEqual(["limit:ip", "limit:credential", "control"]);
  });

  it("PAIR-13 rate limit: a spent credential budget is a 429 that reaches no Screen object", async () => {
    const { calls, env: e } = env(true);
    const res = await post(e);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "rate_limited" }));
    expect(calls).toEqual(["limit:ip", "limit:credential"]);
  });
});
