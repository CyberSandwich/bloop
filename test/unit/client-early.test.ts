// The signed-out owner's claim on /a (core/early.js, present-live.md 5): the preview/open split, the code kept across
// sign-in in sessionStorage and the claim again on return.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createStore } from "../../public/js/core/store.js";
import type { PhoneStateKey } from "../../src/shared/protocol.ts";

class FakeElement {
  constructor(private readonly action: string) {}
  closest() {
    return { getAttribute: () => this.action };
  }
}
let click: ((e: { target: unknown }) => void) | null = null;
const assign = vi.fn();

beforeAll(() => {
  vi.stubGlobal("location", { search: "", pathname: "/a", assign });
  vi.stubGlobal("history", { replaceState: () => {} });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("document", {
    getElementById: () => ({ addEventListener: (_: string, fn: typeof click) => (click = fn) }),
  });
});

/** By a name, as client-viewer.test.ts does: the module reads DOM globals the node tsconfig has no types for. */
const EARLY = "../../public/js/core/early.js";
type Store = ReturnType<typeof createStore>;
type Kept = { code: string; key: string; at: number };
type Words = {
  title: string;
  body: string;
  actions: { label: string; kind: string; href?: string; waitlist?: boolean }[];
};
interface Early {
  keepClaim(store: Store, kept: Kept): void;
  takeClaim(store: Store, now?: number): Kept | null;
  resume(store: Store, claim: (...args: unknown[]) => Promise<void>, none: () => void): void;
  refused(error: string, io: unknown): Promise<void>;
  words(key: string): Words | null;
}
const early = (): Promise<Early> => import(EARLY);
const memory = () => {
  const area = new Map<string, string>();
  return {
    area,
    store: createStore({
      getItem: (k) => area.get(k) ?? null,
      setItem: (k, v) => void area.set(k, v),
      removeItem: (k) => void area.delete(k),
    }),
  };
};

function io(me: unknown) {
  const { area, store } = memory();
  const c = { error: null as PhoneStateKey | null, words: null as unknown };
  return {
    area,
    io: {
      c,
      render: vi.fn(),
      code: "K7MQ9X",
      key: "11111111-1111-4111-8111-111111111111",
      who: Promise.resolve(me),
      store,
      claim: vi.fn(async () => {}),
    },
  };
}

describe("the kept claim (present-live.md 5.1)", () => {
  it("is taken once: read and dropped, so a later /a never replays it", async () => {
    const { keepClaim, takeClaim } = await early();
    const { area, store } = memory();
    keepClaim(store, { code: "K7MQ9X", key: "k", at: 1000 });
    expect(area.get("bloop.resume")).toBe(JSON.stringify({ code: "K7MQ9X", key: "k", at: 1000 }));
    expect(takeClaim(store, 2000)).toEqual({ code: "K7MQ9X", key: "k", at: 1000 });
    expect(area.has("bloop.resume")).toBe(false);
    expect(takeClaim(store, 2000)).toBeNull();
  });

  it("unused for 5 minutes, corrupt, or missing its key, it is none, and it is dropped all the same", async () => {
    const { keepClaim, takeClaim } = await early();
    const { area, store } = memory();
    keepClaim(store, { code: "K7MQ9X", key: "k", at: 0 });
    expect(takeClaim(store, 300_000)).toBeNull();
    expect(takeClaim(store, 299_999)).toBeNull();
    keepClaim(store, { code: "K7MQ9X", key: "k", at: 0 });
    expect(takeClaim(store, 299_999)).not.toBeNull();
    for (const raw of ["{", "null", '{"code":"K7MQ9X","at":0}', '{"key":"k","at":0}']) {
      area.set("bloop.resume", raw);
      expect(takeClaim(store, 1), raw).toBeNull();
      expect(area.has("bloop.resume")).toBe(false);
    }
  });

  it("resume claims the kept code as an owner with its own key, marked resumed; with none, the page goes on", async () => {
    const { keepClaim, resume } = await early();
    const { store } = memory();
    const claim = vi.fn(async () => {});
    const none = vi.fn();
    keepClaim(store, { code: "K7MQ9X", key: "k", at: Date.now() });
    resume(store, claim, none);
    expect(claim).toHaveBeenCalledWith("K7MQ9X", "owner", "k", true);
    resume(store, claim, none);
    expect(none).toHaveBeenCalledOnce();
  });
});

describe("a live code refused signed out (auth_required)", () => {
  it("MODE-01 preview: the same code as a guest, never the early-access state", async () => {
    const { refused } = await early();
    for (const me of [
      { ok: true, value: { signedIn: false, launchMode: "preview" } },
      { ok: true, value: { signedIn: false } },
      { ok: false, error: "offline" },
    ]) {
      const r = io(me);
      await refused("auth_required", r.io);
      expect(r.io.claim, JSON.stringify(me)).toHaveBeenCalledWith("K7MQ9X", "guest");
      expect(r.io.c.error).toBeNull();
    }
  });

  it("open: the early-access state; Sign In keeps the code and its key, then goes to /auth/start", async () => {
    const { refused, takeClaim } = await early();
    const r = io({ ok: true, value: { signedIn: false, launchMode: "open" } });
    await refused("auth_required", r.io);
    expect(r.io.c.error).toBe("early");
    expect(r.io.render).toHaveBeenCalled();
    expect(r.io.claim).not.toHaveBeenCalled();
    // The 5 minutes run from the tap, not from the refusal.
    const tapped = Date.now();
    click?.({ target: new FakeElement("signin") });
    expect(assign).toHaveBeenCalledWith("/auth/start");
    const kept = takeClaim(r.io.store);
    expect(kept).toMatchObject({ code: "K7MQ9X", key: r.io.key });
    expect(kept?.at).toBeGreaterThanOrEqual(tapped);
  });

  it("open: Send One File hands the page back and claims the same code as a guest", async () => {
    const { refused } = await early();
    const r = io({ ok: true, value: { launchMode: "open" } });
    await refused("auth_required", r.io);
    click?.({ target: new FakeElement("guest") });
    expect(r.io.c.error).toBeNull();
    expect(r.io.c.words).toBeFalsy();
    expect(r.io.claim).toHaveBeenCalledWith("K7MQ9X", "guest");
    // Its state is gone, so a second tap does nothing.
    click?.({ target: new FakeElement("guest") });
    expect(r.io.claim).toHaveBeenCalledOnce();
  });

  it("a kept code gone after sign-in reads Scan the Screen Again", async () => {
    const { refused } = await early();
    const r = io({ ok: true, value: {} });
    await refused("code_unknown", r.io);
    expect(r.io.c.error).toBe("rescan");
  });
});

describe("the early-access words (present-live.md 6)", () => {
  it("follow the spec and the voice rules: Title Case labels, no dashes", async () => {
    const { words } = await early();
    const e = words("early");
    expect(e?.title).toBe("Early Access Only");
    expect(e?.body).toBe(
      "Sign in to present your own files. No invite yet? You can still send one file to this screen.",
    );
    expect(e?.actions.map((a) => [a.label, a.kind])).toEqual([
      ["Try the Demo", "text"],
      ["Join the Waitlist", "text"],
      ["Send One File", "secondary"],
      ["Sign In", "primary"],
    ]);
    expect(e?.actions[1]).toMatchObject({ waitlist: true, href: expect.stringContaining("source=phone") });
    const r = words("rescan");
    expect(r?.title).toBe("Scan the Screen Again");
    expect(r?.body).toBe("The code changed while you signed in. You're signed in now, so one scan is all it takes.");
    expect(r?.actions.map((a) => a.label)).toEqual(["Enter the Code"]);
    for (const copy of [e, r]) {
      for (const text of [copy?.title ?? "", copy?.body ?? "", ...(copy?.actions ?? []).map((a) => a.label)])
        expect(text).not.toMatch(/[–—!]/);
      for (const label of [copy?.title ?? "", ...(copy?.actions ?? []).map((a) => a.label)])
        expect(label.split(" ").filter((w) => /^[a-z]/.test(w) && !["the", "a"].includes(w))).toEqual([]);
    }
    expect(words("expired")).toBeNull();
  });
});
