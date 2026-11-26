// LINK-02 in the clients: the screen opens only the https URL in its own item list and tells the server which happened;
// the phone sends an id and toasts the answer once.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, PhoneView, ScreenView } from "../../src/shared/protocol.ts";

// Non-literal specifiers: a literal would make the node tsconfig typecheck page code, which needs the DOM lib.
const OPEN = "../../public/js/core/link-open.js";
const ASK = "../../public/js/core/link-ask.js";
const LINK: Item = { kind: "link", id: "i2", url: "https://www.vevox.com/", title: "Vevox" };
const DECK: Item = { kind: "file", id: "i1", name: "Deck.pdf", type: "pdf", size: 1 };

const pill = {
  hidden: true,
  style: {} as Record<string, string>,
  onclick: null as null | (() => void),
  children: [] as unknown[],
};
vi.mock("../../public/js/core/ui.js", () => ({
  byId: () => ({
    get hidden() {
      return pill.hidden;
    },
    set hidden(value: boolean) {
      pill.hidden = value;
    },
    style: pill.style,
    set onclick(fn: () => void) {
      pill.onclick = fn;
    },
    replaceChildren: (...kids: unknown[]) => {
      pill.children = kids;
    },
  }),
  icon: () => "icon",
}));

const view = (over: Partial<ScreenView> = {}) =>
  ({ items: [DECK, LINK], linkOpen: { item: "i2", n: 1, opened: null }, ...over }) as unknown as ScreenView;

describe("LINK-02 the screen opens only the https URL in its own list", () => {
  const post = vi.fn(async () => ({}));
  const api = { post };
  const open = vi.fn();
  let follow: (view: ScreenView, api: { post: typeof post }, sid: string) => void;

  beforeEach(async () => {
    vi.resetModules();
    post.mockClear();
    open.mockReset();
    pill.hidden = true;
    pill.onclick = null;
    pill.style = {};
    pill.children = [];
    vi.stubGlobal("window", { open });
    follow = (await import(OPEN)).follow;
  });

  it("LINK-02 opened: the tab opens, the opener is cut, no pill shows, and the answer says opened", () => {
    const tab: { opener: unknown } = { opener: {} };
    open.mockReturnValue(tab);
    follow(view(), api, "sid");
    expect(open).toHaveBeenCalledWith("https://www.vevox.com/", "_blank");
    expect(tab.opener).toBeNull();
    expect(pill.hidden).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/screen/opened", { n: 1, opened: true }, "sid");
  });

  it("LINK-02 blocked: a null shows the pill, a real click opens with noopener, and the answer says blocked", () => {
    open.mockReturnValue(null);
    follow(view(), api, "sid");
    expect(pill.hidden).toBe(false);
    expect(pill.children[0]).toBe("Open Vevox");
    expect(pill.style.opacity).toBe("1");
    expect(post).toHaveBeenCalledWith("/api/screen/opened", { n: 1, opened: false }, "sid");
    open.mockClear();
    pill.onclick?.();
    expect(open).toHaveBeenCalledWith("https://www.vevox.com/", "_blank", "noopener,noreferrer");
    expect(pill.hidden).toBe(true);
  });

  it("LINK-02 blocked: a throwing window.open is the same as a refusal", () => {
    open.mockImplementation(() => {
      throw new Error("popup");
    });
    follow(view(), api, "sid");
    expect(pill.hidden).toBe(false);
    expect(post).toHaveBeenCalledWith("/api/screen/opened", { n: 1, opened: false }, "sid");
  });

  it("LINK-02 https: a URL that is not https, or an id that is not a link, is never opened", () => {
    open.mockReturnValue({ opener: null });
    const urls = ["http://www.vevox.com/", "javascript:alert(1)", "data:text/html,x", "//www.vevox.com/", ""];
    // A new ask number each time: the screen acts on an ask once.
    urls.forEach((url, i) => {
      follow(view({ items: [DECK, { ...LINK, url }], linkOpen: { item: "i2", n: i + 1, opened: null } }), api, "sid");
    });
    follow(view({ linkOpen: { item: "i1", n: 10, opened: null } }), api, "sid");
    follow(view({ linkOpen: { item: "i9", n: 11, opened: null } }), api, "sid");
    expect(open).not.toHaveBeenCalled();
    expect(pill.hidden).toBe(true);
    expect(post).toHaveBeenCalledTimes(urls.length + 2);
    // Refused, not blocked: the phone says the screen cannot open it, not "tap Open".
    expect(post).toHaveBeenLastCalledWith("/api/screen/opened", { n: 11, opened: false, refused: true }, "sid");
  });

  it("LINK-02 pill: it goes with a later ask, and with the session, so a past session's link cannot open", () => {
    open.mockReturnValue(null);
    follow(view(), api, "sid");
    expect(pill.hidden).toBe(false);
    // The answered ask still shows the pill; a view with no ask (renewed or ended) takes it away.
    follow(view({ linkOpen: { item: "i2", n: 1, opened: false } }), api, "sid");
    expect(pill.hidden).toBe(false);
    follow(view({ linkOpen: null }), api, "sid");
    expect(pill.hidden).toBe(true);
    // A later ask that opens takes it away too.
    pill.hidden = false;
    open.mockReturnValue({ opener: null });
    follow(view({ linkOpen: { item: "i2", n: 2, opened: null } }), api, "sid");
    expect(pill.hidden).toBe(true);
  });

  it("LINK-02 once: a view that arrives twice, or one already answered, opens one tab", () => {
    open.mockReturnValue({ opener: null });
    follow(view(), api, "sid");
    follow(view(), api, "sid");
    follow(view({ linkOpen: { item: "i2", n: 2, opened: true } }), api, "sid");
    follow(view({ linkOpen: null }), api, "sid");
    expect(open).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    follow(view({ linkOpen: { item: "i2", n: 2, opened: null } }), api, "sid");
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("LINK-02 the phone sends an id and toasts the answer once", () => {
  const toast = vi.fn();
  const post = vi.fn();
  let click: (e: unknown) => Promise<void>;
  let current: PhoneView | null = null;
  let on = true;
  let paint: () => void;

  beforeEach(async () => {
    vi.resetModules();
    toast.mockReset();
    post.mockReset();
    on = true;
    vi.doMock("../../public/js/core/toast.js", () => ({ toast }));
    vi.doMock("../../public/js/core/api.js", () => ({ createApi: () => ({ post }) }));
    vi.stubGlobal("document", {
      getElementById: () => ({
        addEventListener: (_: string, fn: (e: unknown) => Promise<void>) => {
          click = fn;
        },
      }),
    });
    const { mount } = await import(ASK);
    const c = {
      get view() {
        return current;
      },
      pid: "pid",
    };
    current = { v: 1, items: [DECK, LINK] } as unknown as PhoneView;
    paint = mount(
      c,
      (v: PhoneView) => {
        current = v;
      },
      () => on,
    );
  });

  class El {}
  const tap = (item: string | null) => {
    const row = { getAttribute: () => item };
    const target = Object.assign(Object.create(El.prototype), { closest: () => (item === null ? null : row) });
    vi.stubGlobal("Element", El);
    const preventDefault = vi.fn();
    return { event: { target, preventDefault }, preventDefault };
  };

  it("LINK-02 tap: it posts the row's id and nothing else, and keeps the phone from opening the link", async () => {
    post.mockResolvedValue({ ok: true, value: { v: 2, linkOpen: { item: "i2", n: 1, opened: null }, items: [] } });
    const { event, preventDefault } = tap("i2");
    await click(event);
    expect(preventDefault).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/api/control/link", { item: "i2" }, "pid", true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("LINK-02 tap: a row that is no link, or a remote that is not showing, does nothing", async () => {
    const none = tap(null);
    await click(none.event);
    on = false;
    const off = tap("i2");
    await click(off.event);
    expect(post).not.toHaveBeenCalled();
    expect(none.preventDefault).not.toHaveBeenCalled();
    expect(off.preventDefault).not.toHaveBeenCalled();
  });

  it("LINK-02 answer: opened and blocked each toast once, one line apiece, and an answer to another ask is ignored", async () => {
    post.mockResolvedValue({ ok: true, value: { v: 2, linkOpen: { item: "i2", n: 4, opened: null }, items: [] } });
    await click(tap("i2").event);
    current = { v: 3, linkOpen: { item: "i2", n: 3, opened: true } } as unknown as PhoneView;
    paint();
    expect(toast).not.toHaveBeenCalled();
    current = { v: 4, linkOpen: { item: "i2", n: 4, opened: false } } as unknown as PhoneView;
    paint();
    paint();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatchObject({ title: "Tap Open on the Screen" });
    post.mockResolvedValue({ ok: true, value: { v: 5, linkOpen: { item: "i2", n: 5, opened: null }, items: [] } });
    await click(tap("i2").event);
    current = { v: 6, linkOpen: { item: "i2", n: 5, opened: true } } as unknown as PhoneView;
    paint();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1]?.[0]).toMatchObject({ title: "Opened on the Screen" });
  });

  it("LINK-02 race: an answer that arrives by the socket before the ask's reply is toasted from the reply", async () => {
    // The socket's view is newer than the reply and already answered; the reply is not adopted.
    current = { v: 5, linkOpen: { item: "i2", n: 4, opened: true } } as unknown as PhoneView;
    post.mockResolvedValue({ ok: true, value: { v: 2, linkOpen: { item: "i2", n: 4, opened: null }, items: [] } });
    await click(tap("i2").event);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatchObject({ title: "Opened on the Screen" });
  });

  it("LINK-02 refused answer: the screen had no link to open, and the phone says so, not Tap Open", async () => {
    post.mockResolvedValue({ ok: true, value: { v: 2, linkOpen: { item: "i2", n: 6, opened: null }, items: [] } });
    await click(tap("i2").event);
    current = { v: 3, linkOpen: { item: "i2", n: 6, opened: false, refused: true } } as unknown as PhoneView;
    paint();
    expect(toast.mock.calls[0]?.[0]).toMatchObject({ title: "The Screen Can't Open It" });
  });

  it("LINK-02 failed: a failed ask is one error toast, except an ended session, which the socket already says", async () => {
    post.mockResolvedValue({ ok: false, error: "offline" });
    await click(tap("i2").event);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ error: true }));
    toast.mockReset();
    post.mockResolvedValue({ ok: false, error: "session_ended" });
    await click(tap("i2").event);
    expect(toast).not.toHaveBeenCalled();
  });
});
