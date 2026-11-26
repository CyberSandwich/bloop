// LINK-02: the phone asks the screen to open an approved link in a new tab. The phone sends an id; the screen answers
// whether its browser let the tab open.
import { describe, expect, it } from "vitest";
import { type Machine, transition } from "../../src/worker/machine.ts";
import { PROD_VARS } from "../env-vars.ts";
import { asItem, CFG, claimedOwner, DECK, fx, MAX_MINUTES, must, sec, T0, VEVOX } from "./machine-helpers.ts";

const at = T0 + sec(30);
const ask = (item: string) => ({ e: "link.open", now: at, item }) as const;
const answer = (n: number, opened: boolean) => ({ e: "link.opened", now: at, n, opened }) as const;

/** A demo session holding a deck (i1) and the Vevox link (i2). */
const approved = (): Machine =>
  must(claimedOwner(), { e: "approve", now: T0 + sec(10), items: [VEVOX, asItem(DECK)], minutes: MAX_MINUTES }).next;
const refusal = (m: Machine, item: string) => {
  const step = transition(m, ask(item), CFG);
  return step.ok ? null : step.error;
};

describe("LINK-02 the phone asks, by id, for an approved link", () => {
  it("LINK-02 ask: an approved link's id is stored as an ask numbered by the clock and pushed to both", () => {
    const step = must(approved(), ask("i2"));
    expect(step.next.session?.linkOpen).toEqual({ item: "i2", n: at, opened: null });
    expect(fx(step.effects, "push")).toEqual([{ fx: "push", to: "both" }]);
  });

  it("LINK-02 ask: each ask counts, so a screen acts on it once", () => {
    const first = must(approved(), ask("i2")).next;
    expect(must(first, ask("i2")).next.session?.linkOpen).toEqual({ item: "i2", n: at + 1, opened: null });
  });

  it("LINK-02 ask: a later session's first ask is numbered above an earlier session's", () => {
    const earlier = must(approved(), ask("i2")).next.session?.linkOpen?.n ?? 0;
    const later = must(approved(), { ...ask("i2"), now: at + sec(60) }).next.session?.linkOpen?.n ?? 0;
    expect(later).toBeGreaterThan(earlier);
  });

  it("LINK-02 id: a file's id, an unknown id and an index are refused, and nothing is stored", () => {
    const m = approved();
    for (const item of ["i1", "i9", "0", "demo-vevox", ""]) expect(refusal(m, item), item).toBe("file_not_found");
  });

  it("LINK-02 state: not before approval, and never a live screen", () => {
    expect(refusal(claimedOwner(), "i2")).toBe("wrong_state");
    const listed = must(claimedOwner("live"), { e: "listed", now: T0 + sec(2), ids: ["deck-1"] }).next;
    const live = must(listed, { e: "approve", now: T0 + sec(5), items: [asItem(DECK)], minutes: MAX_MINUTES }).next;
    expect(refusal(live, "i1")).toBe("wrong_state");
  });
});

describe("LINK-02 the screen answers once per ask", () => {
  it("LINK-02 answer: opened or blocked is stored on the ask and pushed", () => {
    const asked = must(approved(), ask("i2")).next;
    for (const opened of [true, false]) {
      const step = must(asked, answer(at, opened));
      expect(step.next.session?.linkOpen).toEqual({ item: "i2", n: at, opened });
      expect(fx(step.effects, "push")).toHaveLength(1);
    }
  });

  it("LINK-02 answer: a second answer, or one to another ask, changes nothing", () => {
    const answered = must(must(approved(), ask("i2")).next, answer(at, false)).next;
    expect(must(answered, answer(at, true)).next).toBe(answered);
    const again = must(answered, ask("i2")).next;
    expect(must(again, answer(at, true)).next).toBe(again);
    expect(must(again, answer(7, true)).next).toBe(again);
  });

  it("LINK-02 answer: a refusal is stored as refused, with opened false", () => {
    const asked = must(approved(), ask("i2")).next;
    const step = must(asked, { ...answer(at, false), refused: true });
    expect(step.next.session?.linkOpen).toEqual({ item: "i2", n: at, opened: false, refused: true });
  });

  it("LINK-02 answer: with no ask there is nothing to answer", () => {
    const step = transition(approved(), answer(1, true), CFG);
    expect(step.ok).toBe(false);
  });
});

describe("LINK-02 the routes take an id and an answer, never a URL", () => {
  const ORIGIN = "http://127.0.0.1:8787";
  const PID = `${"S".repeat(22)}.${"p".repeat(43)}`;
  type PostRoute = {
    pattern: URLPattern;
    handler: (r: Request, env: object, m: URLPatternResult) => Promise<Response>;
  };
  const post = async (url: string, body: unknown) => {
    const calls: string[] = [];
    const call = (name: string) => async () => {
      calls.push(name);
      return { ok: true, value: {} };
    };
    const env = {
      ...PROD_VARS,
      PUBLIC_ORIGIN: ORIGIN,
      RL_CONTROL: {
        limit: async () => {
          calls.push("limit");
          return { success: true };
        },
      },
      SCREEN: {
        idFromName: (n: string) => n,
        get: () => ({ openLink: call("openLink"), linkOpened: call("linkOpened") }),
      },
    };
    // A non-literal specifier: the route's type graph needs the Workers types, which the test tsconfig leaves out.
    const path = "../../src/worker/routes/control.ts";
    const routes = (await import(path)) as { controlRoutes: readonly PostRoute[] };
    const request = new Request(`${ORIGIN}${url}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${PID}` },
      body: JSON.stringify(body),
    });
    const route = routes.controlRoutes.find((r) => r.pattern.test(request.url)) as PostRoute;
    const res = await route.handler(request, env, route.pattern.exec(request.url) as URLPatternResult);
    return { status: res.status, calls };
  };

  it("LINK-02 route: an id reaches the object; a body with a URL, or another key, is a 400 that reaches nothing", async () => {
    // Rate-limited like every control event: the IP's budget, then the credential's, then the object.
    expect(await post("/api/control/link", { item: "i2" })).toEqual({
      status: 200,
      calls: ["limit", "limit", "openLink"],
    });
    for (const body of [
      { item: "i2", url: "https://www.vevox.com/" },
      { url: "https://www.vevox.com/" },
      { item: "" },
      { item: "x".repeat(33) },
      {},
    ]) {
      expect(await post("/api/control/link", body), JSON.stringify(body)).toEqual({ status: 400, calls: [] });
    }
  });

  it("LINK-02 route: the screen's answer is a count and a flag, nothing else", async () => {
    expect(await post("/api/screen/opened", { n: 1, opened: false })).toEqual({
      status: 200,
      calls: ["limit", "limit", "linkOpened"],
    });
    for (const body of [{ n: 0, opened: true }, { n: 1.5, opened: true }, { n: 1 }, { n: 1, opened: true, url: "x" }]) {
      expect(await post("/api/screen/opened", body), JSON.stringify(body)).toEqual({ status: 400, calls: [] });
    }
  });
});
