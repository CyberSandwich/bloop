import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../public/js/core/api.js";
import { openChannel, refusal } from "../../public/js/core/channel.js";
import {
  BLOCKED_PROBE_MS,
  COALESCE_MS,
  CONNECT_TIMEOUT_MS,
  PING_MS,
  PROBE_MS,
} from "../../public/js/core/channel-timing.js";
import { downGate, isDown } from "../../public/js/core/poll.js";
import { onRefusal } from "../../public/js/core/states.js";
import { SILENCE_MS } from "../../public/js/core/timing.js";
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

type PollReply = { ok: true; value: unknown } | { ok: false; error: ErrorCode; retryAfter?: number };

/** A reply may be a promise the test settles later; `react` is the page's own onError, handed the channel. */
function setup(
  polls: (PollReply | Promise<PollReply>)[] = [],
  react?: (code: ErrorCode, ch: ReturnType<typeof openChannel>) => void,
  opts: {
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    hidden?: { now: boolean };
    state?: string;
    delay?: number;
  } = {},
) {
  vi.stubGlobal("sessionStorage", opts.storage ?? new Memory());
  vi.stubGlobal("document", {
    get hidden() {
      return opts.hidden?.now ?? false;
    },
  });
  const sockets: FakeSocket[] = [];
  const views: unknown[] = [];
  const errors: ErrorCode[] = [];
  const links: string[] = [];
  const frames: unknown[] = [];
  const pollCalls: string[] = [];
  const api = {
    get: async (path: string, auth?: string | null) => {
      pollCalls.push(`${path}|${auth}`);
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return (await polls.shift()) ?? { ok: true, value: { state: opts.state ?? "waiting" } };
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
  vi.unstubAllGlobals();
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
    expect(t.channel.send({ t: "x" })).toBe(true);
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

  it("pings while open and drops a socket that has gone silent", async () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    await vi.advanceTimersByTimeAsync(0);
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

  it("FLOW-07 wake on a socket heard from within PING_MS reads nothing and pings nothing", async () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "waiting" } });
    t.sockets[0]?.sent.splice(0);
    vi.setSystemTime(Date.now() + PING_MS - 1);
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(PROBE_MS + 1);
    expect(t.pollCalls).toEqual([]);
    expect(t.sockets[0]?.sent).toEqual([]);
    expect(t.sockets).toHaveLength(1);
  });

  it("FLOW-07 wake on a quiet socket pings and reads nothing; with no answer the replacement's hello brings the state", async () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "waiting" } });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + PING_MS + 1);
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(t.sockets).toHaveLength(2);
    expect(t.pollCalls).toEqual([]);
  });

  it("FLOW-07 wake on a dropped socket reconnects at once and reads nothing", async () => {
    const t = setup();
    t.sockets[0]?.drop();
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(2);
    expect(t.pollCalls).toEqual([]);
  });

  it("wake while polling polls now instead of waiting out a 30 s hidden delay", async () => {
    const hidden = { now: true };
    const t = setup([], undefined, { hidden, state: "open" });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(t.pollCalls).toHaveLength(1);
    hidden.now = false;
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(2);
  });

  it("a read answered after a newer push is dropped: an old view never lies over a new one", async () => {
    let answer: (r: PollReply) => void = () => {};
    const late = new Promise<PollReply>((done) => {
      answer = done;
    });
    const t = setup([late]);
    t.sockets[0]?.open();
    // The read goes out, the claim is pushed, then the read comes back with the older waiting view.
    void t.channel.refresh();
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
  const live = async (opts?: Parameters<typeof setup>[2]) => {
    const t = setup([], undefined, opts);
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    await vi.advanceTimersByTimeAsync(0);
    return t;
  };

  it("REL-02 after more than PING_MS quiet, wake pings; no frame back in 3 s replaces the socket at once", async () => {
    const t = await live();
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
    const t = await live();
    vi.setSystemTime(Date.now() + PING_MS + 1);
    t.channel.wake();
    await vi.advanceTimersByTimeAsync(1000);
    t.sockets[0]?.push({ v: 1, t: "pong" });
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]?.closed).toBe(false);
  });

  it("REL-02 a socket heard from within PING_MS is not probed", async () => {
    const t = await live();
    t.sockets[0]?.sent.splice(0);
    t.channel.wake();
    expect(t.sockets[0]?.sent).toEqual([]);
  });
});

describe("REL-15 the silence rule counts missed pings and skips a hidden tab", () => {
  const open = async (hidden: { now: boolean }) => {
    const t = setup([], undefined, { hidden });
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: {} });
    await vi.advanceTimersByTimeAsync(0);
    return t;
  };

  it("REL-15 one missed ping is no loss; the second in a row closes", async () => {
    const t = await open({ now: false });
    vi.advanceTimersByTime(PING_MS);
    vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(false);
    vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(true);
  });

  it("REL-15 an answer between pings resets the count", async () => {
    const t = await open({ now: false });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(PING_MS);
      t.sockets[0]?.push({ v: 1, t: "pong" });
    }
    expect(t.sockets[0]?.closed).toBe(false);
  });

  it("REL-15 a hidden tab is judged by the 70 s silence instead, and showing again starts the count afresh", async () => {
    const hidden = { now: true };
    const t = await open(hidden);
    vi.advanceTimersByTime(PING_MS * 2);
    expect(PING_MS * 2).toBeLessThan(SILENCE_MS);
    expect(t.sockets[0]?.closed).toBe(false);
    hidden.now = false;
    vi.advanceTimersByTime(PING_MS);
    expect(t.sockets[0]?.closed).toBe(false);
    const dead = await open({ now: true });
    vi.advanceTimersByTime(PING_MS * 3);
    expect(dead.sockets[0]?.closed).toBe(true);
  });

  it("REL-15 a missed-ping drop gives the socket up for good: not live, handlers off, a new one on the next try", async () => {
    const t = await open({ now: false });
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(PING_MS);
    const ws = t.sockets[0];
    expect(t.channel.send({ t: "x" })).toBe(false);
    expect(t.channel.send({ t: "x" })).toBe(false);
    expect([ws?.onclose, ws?.onerror, ws?.onmessage, ws?.onopen]).toEqual([null, null, null, null]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sockets).toHaveLength(2);
  });
});

describe("REL-04 a hung upgrade falls to polling, and the next screen polls first", () => {
  it("REL-04 the upgrade has 4 s and polling starts then; only a second timeout in a row sets ws=blocked", async () => {
    const memory = new Memory();
    const t = setup([], undefined, { storage: memory });
    expect(CONNECT_TIMEOUT_MS).toBe(4000);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(1);
    expect(memory.getItem("ws")).toBeNull();
    // The retry (1 s) hangs too.
    await vi.advanceTimersByTimeAsync(1000 + CONNECT_TIMEOUT_MS);
    expect(memory.getItem("ws")).toBe("blocked");
  });

  it("REL-04 a socket that opened and then went quiet, or an ordinary outage, never sets ws=blocked", async () => {
    const memory = new Memory();
    const t = setup([], undefined, { storage: memory });
    // It opened but sent no frame: slow, not swallowed, so the timeout does not count.
    t.sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(t.pollCalls).toHaveLength(1);
    expect(memory.getItem("ws")).toBeNull();
    const down = new Memory();
    const u = setup([], undefined, { storage: down });
    for (const gap of [1000, 2000, 5000]) {
      u.sockets.at(-1)?.drop();
      await vi.advanceTimersByTimeAsync(gap);
    }
    expect(down.getItem("ws")).toBeNull();
  });

  it("REL-04 the blocked retry has the reconnect's jitter, so tabs flagged together do not return together", async () => {
    vi.mocked(Math.random).mockReturnValue(0);
    const memory = new Memory();
    memory.setItem("ws", "blocked");
    const t = setup([], undefined, { storage: memory });
    await vi.advanceTimersByTimeAsync(BLOCKED_PROBE_MS / 2);
    expect(t.sockets).toHaveLength(1);
  });

  it("REL-04 polling is one loop: a timeout or a drop during a poll in flight starts no second", async () => {
    // The reviewer's run: a poll takes 2.5 s, the blocked tab tries the socket each minute for half an hour.
    const memory = new Memory();
    const t = setup([], undefined, { storage: memory, delay: 2500 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // One loop is about 1800 / 5.5 polls; two or more would double it.
    expect(t.pollCalls.length).toBeLessThan(400);
    expect(t.pollCalls.length).toBeGreaterThan(250);
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

  const drops = async (t: ReturnType<typeof setup>) => {
    t.sockets[0]?.drop();
    vi.advanceTimersByTime(1000);
    t.sockets[1]?.drop();
    vi.advanceTimersByTime(2000);
    t.sockets[2]?.drop();
    await vi.advanceTimersByTimeAsync(1);
  };

  it("R11 the second server failure in a row says bloop is down, however slow; one alone says nothing", async () => {
    const t = setup([
      { ok: false, error: "service_down" },
      { ok: false, error: "service_down" },
    ]);
    await drops(t);
    expect(t.links).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.links).toEqual(["down"]);
  });

  it("R11 an internal 500 counts the same as service_down, on a poll as on a boot", async () => {
    const t = setup([
      { ok: false, error: "internal" },
      { ok: false, error: "internal" },
    ]);
    await drops(t);
    expect(t.links).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.links).toEqual(["down"]);
  });

  it("R11 any other answer between two failures starts the count again", async () => {
    const t = setup([
      { ok: false, error: "service_down" },
      { ok: false, error: "offline" },
      { ok: false, error: "service_down" },
    ]);
    await drops(t);
    await vi.advanceTimersByTimeAsync(5000 + 10_000);
    expect(t.links).toEqual(["offline"]);
  });

  it("R11 downGate counts consecutive failures; any other answer resets", () => {
    const gate = downGate();
    expect(gate(true)).toBe(false);
    expect(gate(true)).toBe(true);
    expect(gate(true)).toBe(true);
    expect(gate(false)).toBe(false);
    expect(gate(true)).toBe(false);
    expect(isDown("service_down") && isDown("internal")).toBe(true);
    expect(isDown("offline") || isDown("rate_limited") || isDown("network_blocked")).toBe(false);
  });
});

describe("O19 polling follows the room's state, the tab and Retry-After (REL)", () => {
  const blocked = () => {
    const memory = new Memory();
    memory.setItem("ws", "blocked");
    return memory;
  };
  const perMinute = async (opts: Parameters<typeof setup>[2]) => {
    const t = setup([], undefined, { storage: blocked(), ...opts });
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    return t.pollCalls.length;
  };

  it("REL a blocked socket in waiting polls about every 3 s", async () => {
    expect(await perMinute({ state: "waiting" })).toBe(20);
  });

  it("REL in open it polls every 15 s, and a hidden tab every 30 s", async () => {
    expect(await perMinute({ state: "open" })).toBe(4);
    expect(await perMinute({ state: "open", hidden: { now: true } })).toBe(2);
  });

  it("a 429 with Retry-After waits at least that long, and no more than the cap", async () => {
    const t = setup([{ ok: false, error: "rate_limited", retryAfter: 40 }], undefined, { storage: blocked() });
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pollCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(t.pollCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.pollCalls).toHaveLength(2);
  });
});

describe("O10 send coalesces over COALESCE_MS", () => {
  const live = () => {
    const t = setup();
    t.sockets[0]?.open();
    t.sockets[0]?.push({ v: 1, t: "state", view: { state: "open" } });
    t.sockets[0]?.sent.splice(0);
    return t;
  };

  it("the first frame goes at once; a burst after it sends the latest of each type once the window ends", async () => {
    const t = await live();
    expect(t.channel.send({ t: "page", n: 1 })).toBe(true);
    t.channel.send({ t: "page", n: 2 });
    t.channel.send({ t: "page", n: 3 });
    t.channel.send({ t: "sound", on: true });
    expect(t.sockets[0]?.sent).toEqual(['{"v":1,"t":"page","n":1}']);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(t.sockets[0]?.sent.slice(1)).toEqual(['{"v":1,"t":"page","n":3}', '{"v":1,"t":"sound","on":true}']);
    // The window restarts after a flush, then goes quiet.
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    t.channel.send({ t: "page", n: 4 });
    expect(t.sockets[0]?.sent).toHaveLength(4);
    expect(t.sockets[0]?.sent.at(-1)).toBe('{"v":1,"t":"page","n":4}');
  });

  it("a frame sent while no socket is live is refused, and a drop discards what waited", async () => {
    const t = await live();
    t.channel.send({ t: "page", n: 1 });
    t.channel.send({ t: "page", n: 2 });
    t.sockets[0]?.drop();
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(t.sockets[0]?.sent).toEqual(['{"v":1,"t":"page","n":1}']);
    expect(t.channel.send({ t: "page", n: 3 })).toBe(false);
  });
});
