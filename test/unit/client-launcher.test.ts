import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../public/js/core/store.js";
import {
  DOWNLOAD_REUSE_MS,
  DOWNLOAD_STARTS_PER_LINK,
  LAUNCH_TIMEOUT_MS,
  RELINK_WAIT_MS,
} from "../../public/js/core/timing.js";
import { createLauncher } from "../../public/js/launcher.js";
import { createResidue } from "../../public/js/residue.js";
import type { LinkSet, ScreenView } from "../../src/shared/protocol.ts";

const PROTOCOL = "ms-powerpoint:ofv|u|https://bloop.test/f/tok/Deck.pptx";
const links = (over: Partial<LinkSet> = {}): LinkSet => ({ protocol: null, download: null, pdf: null, ...over });
const view = (state: ScreenView["state"]): ScreenView => ({
  state,
  mode: "demo",
  kind: "owner",
  room: { name: "Demo room", registered: false },
  code: null,
  match: "42",
  fileName: "Deck.pptx",
  fileType: "pptx",
  fileSize: null,
  openMode: null,
  endsAt: null,
  endReason: null,
  now: 0,
});

function harness(opts: { gesture?: boolean; popups?: boolean; minted?: LinkSet | "fail" | "pdf_unavailable" } = {}) {
  const calls = {
    assign: [] as string[],
    windows: [] as string[],
    downloads: [] as string[],
    reports: [] as string[],
    posts: [] as { path: string; body: unknown; auth: unknown }[],
    changes: 0,
    closed: 0,
  };
  const state = { gesture: opts.gesture ?? true, popups: opts.popups ?? true };
  const launcher = createLauncher({
    api: {
      post: async (path: string, body: unknown, auth: unknown) => {
        calls.posts.push({ path, body, auth });
        if (opts.minted === "pdf_unavailable") return { ok: false, error: "pdf_unavailable" };
        return opts.minted === "fail" || !opts.minted
          ? { ok: false, error: "mint_limit" }
          : { ok: true, value: { links: opts.minted }, headers: { get: () => null } };
      },
    } as never,
    sid: () => "sid.secret",
    assign: (url) => void calls.assign.push(url),
    openWindow: (url) => {
      calls.windows.push(url);
      return state.popups ? { close: () => void calls.closed++ } : null;
    },
    startDownload: (url) => void calls.downloads.push(url),
    hasGesture: () => state.gesture,
    report: (mode) => {
      calls.reports.push(mode);
      return true;
    },
    onChange: () => void calls.changes++,
  });
  return { launcher, calls, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("launch: the protocol link", () => {
  it("assigns the URI once, reports the launch once, and ignores the same link arriving again", () => {
    const { launcher, calls } = harness();
    launcher.launch(links({ protocol: PROTOCOL }));
    launcher.launch(links({ protocol: PROTOCOL }));
    expect(calls.assign).toEqual([PROTOCOL]);
    expect(calls.reports).toEqual(["protocol"]);
    expect(launcher.needsClick()).toBe(false);
  });

  it("without a user gesture it launches anyway and asks for a click, which launches again", () => {
    const { launcher, calls, state } = harness({ gesture: false });
    launcher.launch(links({ protocol: PROTOCOL }));
    expect(calls.assign).toEqual([PROTOCOL]);
    expect(launcher.needsClick()).toBe(true);
    state.gesture = true;
    launcher.click();
    expect(calls.assign).toEqual([PROTOCOL, PROTOCOL]);
    expect(launcher.needsClick()).toBe(false);
    expect(calls.reports).toEqual(["protocol"]);
  });

  it("the open state means PowerPoint fetched it: no click needed any more", () => {
    const { launcher } = harness({ gesture: false });
    launcher.launch(links({ protocol: PROTOCOL }));
    launcher.onView(view("open"));
    expect(launcher.needsClick()).toBe(false);
  });
});

describe("the Download fallback timing", () => {
  it("is not ready at launch, and becomes ready after the launch timeout with no fetch", () => {
    const { launcher, calls } = harness();
    launcher.launch(links({ protocol: PROTOCOL }));
    launcher.onView(view("opening"));
    expect(launcher.downloadReady()).toBe(false);
    vi.advanceTimersByTime(LAUNCH_TIMEOUT_MS - 1);
    expect(launcher.downloadReady()).toBe(false);
    const before = calls.changes;
    vi.advanceTimersByTime(1);
    expect(launcher.downloadReady()).toBe(true);
    expect(calls.changes).toBe(before + 1);
  });

  it("a fetch inside the timeout (state open) cancels the wait", () => {
    const { launcher } = harness();
    launcher.onView(view("opening"));
    vi.advanceTimersByTime(LAUNCH_TIMEOUT_MS - 1000);
    launcher.onView(view("open"));
    vi.advanceTimersByTime(5000);
    expect(launcher.downloadReady()).toBe(false);
  });
});

describe("download and showPdf", () => {
  it("download posts the purpose with the screen credential and starts the download once, frame or not", async () => {
    const minted = links({ download: "https://bloop.test/f/t2/Deck.pptx" });
    const { launcher, calls } = harness({ minted });
    expect(await launcher.download()).toBe("ok");
    launcher.launch(minted); // the same link also arrives as an `open` frame
    expect(calls.posts).toEqual([{ path: "/api/screen/link", body: { purpose: "download" }, auth: "sid.secret" }]);
    expect(calls.downloads).toEqual(["https://bloop.test/f/t2/Deck.pptx"]);
  });

  it("a second Download soon after reuses the started link instead of minting, up to its share of fetches", async () => {
    const url = "https://bloop.test/f/t2/Deck.pptx";
    const { launcher, calls } = harness({ minted: links({ download: url }) });
    for (let i = 0; i < DOWNLOAD_STARTS_PER_LINK; i++) expect(await launcher.download()).toBe("ok");
    expect(calls.posts).toHaveLength(1);
    expect(calls.downloads).toEqual(Array(DOWNLOAD_STARTS_PER_LINK).fill(url));
    await launcher.download();
    expect(calls.posts).toHaveLength(2);
  });

  it("a started link is not reused once its reuse window has passed", async () => {
    const { launcher, calls } = harness({ minted: links({ download: "https://bloop.test/f/t2/Deck.pptx" }) });
    await launcher.download();
    vi.advanceTimersByTime(DOWNLOAD_REUSE_MS);
    await launcher.download();
    expect(calls.posts).toHaveLength(2);
  });

  it("a download link pushed as a frame is reused by the Download control too", async () => {
    const url = "https://bloop.test/f/t5/Deck.pptx";
    const { launcher, calls } = harness();
    launcher.launch(links({ download: url }));
    expect(await launcher.download()).toBe("ok");
    expect(calls.posts).toEqual([]);
    expect(calls.downloads).toEqual([url, url]);
  });

  it("the mint limit is no failure to flag: it marks the budget spent, which reset clears", async () => {
    const { launcher, calls } = harness({ minted: "fail" });
    expect(launcher.spent()).toBe(false);
    expect(await launcher.download()).toBe("spent");
    expect(launcher.spent()).toBe(true);
    expect(calls.changes).toBe(1);
    expect(await launcher.showPdf()).toBe("spent");
    expect(calls.downloads).toEqual([]);
    expect(calls.windows).toEqual([]);
    launcher.reset();
    expect(launcher.spent()).toBe(false);
  });

  it("any other refused mint (a missing PDF, the network) fails and starts nothing", async () => {
    const { launcher, calls } = harness({ minted: "pdf_unavailable" });
    expect(await launcher.download()).toBe("failed");
    expect(await launcher.showPdf()).toBe("failed");
    expect(launcher.spent()).toBe(false);
    expect(calls.downloads).toEqual([]);
    expect(calls.windows).toEqual([]);
  });

  it("RES-04 pdf-window: the PDF view opens in a window this page can close, and the residue step closes it", async () => {
    const pdf = "https://bloop.test/f/t3/Deck.pdf";
    const { launcher, calls } = harness({ minted: links({ pdf }) });
    expect(await launcher.showPdf()).toBe("ok");
    expect(calls.windows).toEqual([pdf]);
    launcher.reset();
    expect(calls.closed).toBe(1);
  });

  it("a blocked popup keeps the link for the Open control and opens it on the click", async () => {
    const pdf = "https://bloop.test/f/t3/Deck.pdf";
    const { launcher, calls, state } = harness({ minted: links({ pdf }), popups: false });
    await launcher.showPdf();
    expect(launcher.needsClick()).toBe(true);
    state.popups = true;
    launcher.click();
    expect(calls.windows).toEqual([pdf, pdf]);
    expect(launcher.needsClick()).toBe(false);
  });

  it("a PDF file's first link opens the view and reports the launch as pdf", () => {
    const pdf = "https://bloop.test/f/t4/Handout.pdf";
    const { launcher, calls } = harness();
    launcher.launch(links({ pdf }));
    expect(calls.windows).toEqual([pdf]);
    expect(calls.reports).toEqual(["pdf"]);
  });
});

describe("a screen that lost its link", () => {
  it("an approved screen with no link asks for the protocol link after a short wait", async () => {
    const minted = links({ protocol: PROTOCOL });
    const { launcher, calls } = harness({ minted });
    launcher.onView(view("approved"));
    expect(calls.posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(RELINK_WAIT_MS);
    expect(calls.posts).toEqual([{ path: "/api/screen/link", body: { purpose: "protocol" }, auth: "sid.secret" }]);
    expect(calls.assign).toEqual([PROTOCOL]);
  });

  it("does not ask when the frame arrived first", async () => {
    const { launcher, calls } = harness({ minted: links({ protocol: PROTOCOL }) });
    launcher.launch(links({ protocol: PROTOCOL }));
    launcher.onView(view("approved"));
    await vi.advanceTimersByTimeAsync(RELINK_WAIT_MS * 2);
    expect(calls.posts).toEqual([]);
  });
});

describe("end of session", () => {
  it("forgets every link and flag, so the next session launches afresh", () => {
    const { launcher, calls } = harness({ gesture: false });
    launcher.launch(links({ protocol: PROTOCOL }));
    launcher.onView(view("opening"));
    launcher.onView(view("ended"));
    expect(launcher.needsClick()).toBe(false);
    expect(launcher.downloadReady()).toBe(false);
    launcher.launch(links({ protocol: PROTOCOL }));
    expect(calls.assign).toEqual([PROTOCOL, PROTOCOL]);
    expect(calls.reports).toEqual(["protocol", "protocol"]);
  });
});

describe("RES-01 residue on the screen page", () => {
  function area(entries: Record<string, string>) {
    const map = new Map(Object.entries(entries));
    return {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      keys: () => [...map.keys()],
    };
  }

  it("clears the launcher, the stored credential, every bloop key and the address bar, and leaves other keys alone", () => {
    const raw = area({ "bloop.sid": "s", "bloop.pid": "p", "bloop.other": "x", theme: "light" });
    const store = createStore(raw as unknown as Storage);
    const reset = vi.fn();
    const cleanUrl = vi.fn();
    const residue = createResidue({ store, launcher: { reset }, storage: raw, cleanUrl });
    residue.clear();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(cleanUrl).toHaveBeenCalledTimes(1);
    expect(raw.keys()).toEqual(["theme"]);
    expect(store.get("bloop.sid")).toBeNull();
    residue.clear(); // idempotent
    expect(raw.keys()).toEqual(["theme"]);
  });

  it("survives storage that throws, and names what a page cannot reach", () => {
    const broken = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    const residue = createResidue({
      store: createStore(null),
      launcher: { reset() {} },
      storage: broken,
      cleanUrl() {},
    });
    expect(() => residue.clear()).not.toThrow();
    expect(residue.beyondReach).toContain("office_recent_list");
  });
});
