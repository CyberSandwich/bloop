import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../public/js/core/api.js";
import { openChannel, type SocketLike } from "../../public/js/core/channel.js";
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

type PollReply = { ok: true; value: unknown } | { ok: false; error: ErrorCode };

function setup(polls: PollReply[] = []) {
  const sockets: FakeSocket[] = [];
  const views: unknown[] = [];
  const errors: ErrorCode[] = [];
  const links: string[] = [];
  const frames: unknown[] = [];
  const pollCalls: string[] = [];
  const api = {
    get: async (path: string, auth?: string | null) => {
      pollCalls.push(`${path}|${auth}`);
      return polls.shift() ?? { ok: true, value: { state: "waiting" } };
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
    onError: (c) => errors.push(c),
    onFrame: (f) => frames.push(f),
    onLink: (l) => links.push(l),
  });
  return { channel, sockets, views, errors, links, frames, pollCalls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

  it("a server failure while polling is down, not offline", async () => {
    const t = setup([{ ok: false, error: "service_down" }]);
    for (const gap of [1000, 2000]) {
      t.sockets[t.sockets.length - 1]?.drop();
      vi.advanceTimersByTime(gap);
    }
    t.sockets[t.sockets.length - 1]?.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.links).toEqual(["down"]);
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

  it("stop closes the socket and never reconnects", () => {
    const t = setup();
    t.sockets[0]?.open();
    t.channel.stop();
    expect(t.sockets[0]?.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(t.sockets).toHaveLength(1);
  });
});
