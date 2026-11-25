import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../public/js/core/api.js";
import { downGate, openChannel, refusal } from "../../public/js/core/channel.js";
import { onRefusal } from "../../public/js/core/states.js";
import {
  BLOCKED_PROBE_MS,
  CONNECT_TIMEOUT_MS,
  DOWN_CONFIRM_MS,
  PING_MS,
  PROBE_MS,
} from "../../public/js/core/timing.js";
import type { SocketLike } from "../../public/js/types.js";
import type { ErrorCode } from "../../src/shared/protocol.ts";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  push(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    this.onclose?.({});
  }
}

/** A tab's sessionStorage, as far as the channel uses it. */
class Memory {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

type PollReply = { ok: true; value: unknown } | { ok: false; error: ErrorCode };

/** A reply may be a promise the test settles later; `react` is the page's own onError, handed the channel. */
function setup(
  polls: (PollReply | Promise<PollReply>)[] = [],
  react?: (code: ErrorCode, ch: ReturnType<typeof openChannel>) => void,
  opts: { storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null; hidden?: { now: boolean } } = {},
) {
  const sockets: FakeSocket[] = [];
  const views: unknown[] = [];
  const errors: ErrorCode[] = [];
  const links: string[] = [];
  const frames: unknown[] = [];
  const pollCalls: string[] = [];
  const api = {
    get: async (path: string, auth?: string | null) => {
      pollCalls.push(`${path}|${auth}`);
      return (await polls.shift()) ?? { ok: true, value: { state: "waiting" } };
    },
  } as unknown as Api;
  const channel = openChannel({
    url: "ws://x/api/screen/ws?ref=REF",
    statePath: "/api/screen/state",
    credential: "REF.SECRET",
    helloKey: "sid",
    api,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onView: (v) => views.push(v),
    onError: (c) => {
      errors.push(c);
      react?.(c, channel);
    },
    onFrame: (f) => frames.push(f),
    onLink: (l) => links.push(l),
    storage: opts.storage ?? null,
    hidden: () => opts.hidden?.now ?? false,
  });
  return { channel, sockets, views, errors, links, frames, pollCalls };
}

// Full jitter: the delays below are the steps themselves (REL-01 has its own test).
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PAIR-12 a refused credential read", () => {
  it("drops the pid only for a dead credential; the network and anything else retry and keep it", () => {
    for (const code of ["unauthorized", "pairing_invalid", "screen_gone"] as const) expect(refusal(code)).toBe("dead");
    for (const code of ["offline", "service_down"] as const) expect(refusal(code)).toBe("offline");
    for (const code of ["rate_limited", "bad_request", "internal"] as const) expect(refusal(code)).toBe("retry");
  });
});

describe("live channel", () => {
  it("sends the credential in the first frame, not in the URL", () => {
    const t = setup();
    t.sockets[0]?.open();
    expect(JSON.parse(t.sockets[0]?.sent[0] ?? "{}")).toEqual({ v: 1, t: "hello", sid: "REF.SECRET" });
  });

  it("keeps the credential out of the URL it connects to", () => {
    const urls: string[] = [];
    openChannel({
      url: "ws://x/api/screen/ws?ref=REF",
      statePath: "/s",
      credential: "REF.SECRET",
      helloKey: "sid",
      api: {} as Api,
      connect: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
      onView: () => {},
      onError: () => {},
      onLink: () => {},
    });
    expect(urls).toEqual(["ws://x/api/screen/ws?ref=REF"]);
  });

  it("delivers state frames and reports the link as ok", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "waiting" } });
    expect(t.views).toEqual([{ state: "waiting" }]);
    expect(t.links).toEqual(["ok"]);
    expect(t.channel.isLive()).toBe(true);
  });

  it("hands other frames to onFrame, and ignores pong, junk and wrong versions", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "open", links: {} });
    t.sockets[0]?.push({ v: 1, t: "pong" });
    t.sockets[0]?.push({ v: 2, t: "state", view: {} });
    t.sockets[0]?.onmessage?.({ data: "not json" });
    expect(t.frames).toEqual([{ v: 1, t: "open", links: {} }]);
    expect(t.views).toEqual([]);
  });

  it("reconnects after 1, 2, 5, 10 then 30 s", () => {
    const t = setup();
    const gaps = [1000, 2000, 5000, 10_000, 30_000, 30_000];
    for (const [i, gap] of gaps.entries()) {
      expect(t.sockets).toHaveLength(i + 1);
      t.sockets[i]?.drop();
      vi.advanceTimersByTime(gap - 1);
      expect(t.sockets).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(t.sockets).toHaveLength(i + 2);
    }
  });

  it("a connection that got a frame resets the backoff to 1 s", () => {
    const t = setup();
    t.sockets[0]?.drop();
    vi.advanceTimersByTime(1000);
    t.sockets[1]?.drop();
    vi.advanceTimersByTime(2000);
    t.sockets[2]?.open();
    t.sockets[2]?.push({ v: 1, t: "state", view: {} });
    t.sockets[2]?.drop();
    vi.advanceTimersByTime(1000);
    expect(t.sockets).toHaveLength(4);
  });

  it("starts polling the state route after 3 failed reconnects, and stops once a socket works", async () => {
    const t = setup([{ ok: true, value: { state: "claimed" } }]);
    t.sockets[0]?.drop();
    vi.advanceTimersByTime(1000);
    t.sockets[1]?.drop();
    vi.advanceTimersByTime(2000);
    expect(t.pollCalls).toEqual([]);
    t.sockets[2]?.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pollCalls).toEqual(["/api/screen/state|REF.SECRET"]);
    expect(t.views).toEqual([{ state: "claimed" }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.pollCalls).toHaveLength(2);

    vi.advanceTimersByTime(5000);
    const last = t.sockets[t.sockets.length - 1];
    last?.open();
    last?.push({ v: 1, t: "state", view: { state: "open" } });
    const polled = t.pollCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.pollCalls).toHaveLength(polled);
  });

  it("a socket that never answers (no open, close or error) is dropped at the connect timeout and polling starts at once", async () => {
    const t = setup([{ ok: true, value: { state: "claimed" } }]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(t.pollCalls).toEqual([]);
    expect(t.sockets[0]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sockets[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toEqual(["/api/screen/state|REF.SECRET"]);
    expect(t.views).toEqual([{ state: "claimed" }]);
    // The socket is retried on the usual backoff, while the poll keeps the page current.
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sockets).toHaveLength(2);
  });

  it("an open socket that never sends a first frame times out the same way, and a late close adds no second failure", async () => {
    const t = setup();
    t.sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(1);
    t.sockets[0]?.drop();
    await vi.advanceTimersByTimeAsync(998);
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sockets).toHaveLength(2);
  });

  it("a socket whose first frame arrives in time is kept, and never polled", async () => {
    const t = setup();
    t.sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "waiting" } });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]?.closed).toBe(false);
    expect(t.pollCalls).toEqual([]);
  });

  it("stop cancels a pending connect timeout", async () => {
    const t = setup();
    t.channel.stop();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(t.pollCalls).toEqual([]);
    expect(t.sockets).toHaveLength(1);
  });

  it("reports offline when polls fail, backing off 5 s", async () => {
    const t = setup([
      { ok: false, error: "offline" },
      { ok: false, error: "offline" },
      { ok: true, value: { state: "waiting" } },
    ]);
    for (const gap of [1000, 2000]) {
      t.sockets[t.sockets.length - 1]?.drop();
      vi.advanceTimersByTime(gap);
    }
    t.sockets[t.sockets.length - 1]?.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.links).toEqual(["offline"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(t.pollCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.links.at(-1)).toBe("ok");
  });

  it("a dead credential in a poll stops the channel and says why", async () => {
    const t = setup([{ ok: false, error: "unauthorized" }]);
    for (const gap of [1000, 2000]) {
      t.sockets[t.sockets.length - 1]?.drop();
      vi.advanceTimersByTime(gap);
    }
    t.sockets[t.sockets.length - 1]?.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors).toEqual(["unauthorized"]);
    const before = t.sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(before);
    expect(t.pollCalls).toHaveLength(1);
  });

  it("a pushed fatal error stops reconnecting", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "error", code: "pairing_invalid", now: 1 });
    t.sockets[0]?.drop();
    vi.advanceTimersByTime(120_000);
    expect(t.errors).toEqual(["pairing_invalid"]);
    expect(t.sockets).toHaveLength(1);
  });

  it("a pushed error that is not fatal keeps the connection", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "error", code: "rate_limited", now: 1 });
    expect(t.errors).toEqual(["rate_limited"]);
    expect(t.sockets[0]?.closed).toBe(false);
  });

  it("send works only while live", () => {
    const t = setup();
    expect(t.channel.send({ t: "code.next" })).toBe(false);
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    expect(t.channel.send({ t: "code.next" })).toBe(true);
    expect(JSON.parse(t.sockets[0]?.sent.at(-1) ?? "{}")).toEqual({ v: 1, t: "code.next" });
  });

  it("pings while open and drops a socket that has gone silent", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    vi.advanceTimersByTime(25_000);
    expect(t.sockets[0]?.sent.at(-1)).toBe('{"v":1,"t":"ping"}');
    vi.advanceTimersByTime(25_000);
    vi.advanceTimersByTime(25_000);
    expect(t.sockets[0]?.closed).toBe(true);
  });

  it("nudge reconnects at once", () => {
    const t = setup();
    t.sockets[0]?.drop();
    t.channel.nudge();
    expect(t.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(t.sockets).toHaveLength(2);
  });

  it("wake reads the state even on a live socket, so a tab whose timers slept catches up (a room screen's code)", async () => {
    const t = setup([{ ok: true, value: { state: "waiting", code: { code: "NEW234" } } }]);
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "waiting", code: { code: "OLD234" } } });
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(1);
    expect(t.pollCalls).toEqual(["/api/screen/state|REF.SECRET"]);
    expect(t.views.at(-1)).toEqual({ state: "waiting", code: { code: "NEW234" } });
  });

  it("wake on a dropped socket reconnects at once and reads the state", async () => {
    const t = setup();
    t.sockets[0]?.drop();
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(2);
    expect(t.pollCalls).toHaveLength(1);
  });

  it("a wake read answered after a newer push is dropped: an old view never lies over a new one", async () => {
    let answer: (r: PollReply) => void = () => {};
    const late = new Promise<PollReply>((done) => {
      answer = done;
    });
    const t = setup([late]);
    t.sockets[0]?.open();
    // The wake's read goes out, the claim is pushed, then the read comes back with the older waiting view.
    t.channel.wake();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "claimed" } });
    answer({ ok: true, value: { state: "waiting" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.views).toEqual([{ state: "claimed" }]);
  });

  it("PAIR-12 a phone at a result stops its channel on a later refusal: nothing reconnects or repaints", async () => {
    const ended = {
      error: null,
      info: null,
      view: { state: "ended", endReason: "phone" },
      files: null,
      selected: [],
      approving: false,
      canceled: false,
      drop: null,
      canceling: false,
    } as unknown as Parameters<typeof onRefusal>[0];
    const t = setup([], (code, ch) => onRefusal(ended, code, { drop() {}, stop: () => ch.stop(), fail() {} }));
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "ended" } });
    t.sockets[0]?.push({ v: 1, t: "error", code: "rate_limited" });
    expect(t.sockets[0]?.closed).toBe(true);
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.views).toEqual([{ state: "ended" }]);
  });

  it("a stopped channel delivers no late state", async () => {
    const t = setup();
    const read = t.channel.refresh();
    t.channel.stop();
    await read;
    expect(t.views).toEqual([]);
  });

  it("stop closes the socket and never reconnects", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.channel.stop();
    expect(t.sockets[0]?.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(t.sockets).toHaveLength(1);
  });
});

describe("REL-02 a socket that says it is open after a long quiet is probed", () => {
  const live = (opts?: Parameters<typeof setup>[2]) => {
    const t = setup([], undefined, opts);
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    return t;
  };

  it("REL-02 after more than PING_MS quiet, wake pings; no frame back in 3 s replaces the socket at once", async () => {
    const t = live();
    t.sockets[0]?.sent.splice(0);
    // The tab slept: nothing was heard (and no ping tick ran).
    vi.setSystemTime(Date.now() + PING_MS + 1);
    t.channel.wake();
    expect(t.sockets[0]?.sent.at(-1)).toBe('{"v":1,"t":"ping"}');
    await vi.advanceTimersByTimeAsync(PROBE_MS - 1);
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sockets[0]?.closed).toBe(true);
    // No backoff wait: the replacement is already there.
    expect(t.sockets).toHaveLength(2);
  });

  it("REL-02 an answer inside 3 s keeps the socket", async () => {
    const t = live();
    vi.setSystemTime(Date.now() + PING_MS + 1);
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(1000);
    t.sockets[0]?.push({ v: 1, t: "pong" });
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]?.closed).toBe(false);
  });

  it("REL-02 a socket heard from within PING_MS is not probed", () => {
    const t = live();
    t.sockets[0]?.sent.splice(0);
    t.channel.wake();
    expect(t.sockets[0]?.sent).toEqual([]);
  });
});

describe("REL-15 the silence rule counts missed pings and skips a hidden tab", () => {
  const open = (hidden: { now: boolean }) => {
    const t = setup([], undefined, { hidden });
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    return t;
  };

  it("REL-15 one missed ping is no loss; the second in a row closes", () => {
    const t = open({ now: false });
    vi.advanceTimersByTime(PING_MS);
    vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(false);
    vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(true);
  });

  it("REL-15 an answer between pings resets the count", () => {
    const t = open({ now: false });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(PING_MS);
      t.sockets[0]?.push({ v: 1, t: "pong" });
    }
    expect(t.sockets[0]?.closed).toBe(false);
  });

  it("REL-15 a hidden tab is never judged, and a slipped wake-up on showing again closes nothing", () => {
    const hidden = { now: true };
    const t = open(hidden);
    for (let i = 0; i < 6; i++) vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(false);
    hidden.now = false;
    vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(false);
  });
});

describe("REL-04 a hung upgrade falls to polling, and the next screen polls first", () => {
  it("REL-04 the upgrade has 4 s; polling starts at that moment and ws=blocked is kept for the tab", async () => {
    const memory = new Memory();
    const t = setup([], undefined, { storage: memory });
    expect(CONNECT_TIMEOUT_MS).toBe(4000);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(1);
    expect(memory.getItem("ws")).toBe("blocked");
  });

  it("REL-04 with ws=blocked the next channel polls from the first second and tries the socket once a minute", async () => {
    const memory = new Memory();
    memory.setItem("ws", "blocked");
    const t = setup([], undefined, { storage: memory });
    expect(t.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BLOCKED_PROBE_MS - 2);
    expect(t.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sockets).toHaveLength(1);
    // The probe fails too: the next one is another minute away, and polling goes on.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BLOCKED_PROBE_MS);
    expect(t.sockets).toHaveLength(2);
    expect(memory.getItem("ws")).toBe("blocked");
  });

  it("REL-04 a probe that works clears the flag and ends polling", async () => {
    const memory = new Memory();
    memory.setItem("ws", "blocked");
    const t = setup([], undefined, { storage: memory });
    await vi.advanceTimersByTimeAsync(BLOCKED_PROBE_MS);
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "open" } });
    expect(memory.getItem("ws")).toBeNull();
    const polled = t.pollCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.pollCalls).toHaveLength(polled);
  });

  it("REL-04 a storage that throws leaves the channel working", async () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const t = setup([], undefined, { storage: broken });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(t.pollCalls).toHaveLength(1);
  });
});

describe("REL-03 and R11 what a failed poll says", () => {
  it("a blocked network is its own link state", async () => {
    const t = setup([{ ok: false, error: "network_blocked" }]);
    t.sockets[0]?.drop();
    vi.advanceTimersByTime(1000);
    t.sockets[1]?.drop();
    vi.advanceTimersByTime(2000);
    t.sockets[2]?.drop();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.links).toEqual(["blocked"]);
  });

  it("R11 the second service_down within 10 s says bloop is down; one alone says nothing", async () => {
    const t = setup([
      { ok: false, error: "service_down" },
      { ok: false, error: "service_down" },
    ]);
    t.sockets[0]?.drop();
    vi.advanceTimersByTime(1000);
    t.sockets[1]?.drop();
    vi.advanceTimersByTime(2000);
    t.sockets[2]?.drop();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.links).toEqual([]);
    // The poll backs off 5 s: the second answer lands inside the window.
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.links).toEqual(["down"]);
  });

  it("R11 downGate: two in a row inside the window confirm; a gap or any other answer resets", () => {
    const gate = downGate();
    expect(gate(true, 0)).toBe(false);
    expect(gate(true, DOWN_CONFIRM_MS)).toBe(true);
    expect(gate(true, DOWN_CONFIRM_MS * 3)).toBe(false);
    expect(gate(false, DOWN_CONFIRM_MS * 3 + 1)).toBe(false);
    expect(gate(true, DOWN_CONFIRM_MS * 3 + 2)).toBe(false);
  });
});
