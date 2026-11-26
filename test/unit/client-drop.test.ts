import { afterEach, describe, expect, it, vi } from "vitest";
import { fileProblem, kindOf, prepareFile, wholeMB } from "../../public/js/core/drop.js";

const MB = 1024 * 1024;

describe("what a phone can check before sending", () => {
  it("accepts a deck, PDF, photo or video within the cap, in any case", () => {
    for (const name of ["Talk.pptx", "NOTES.PDF", "a.jpg", "a.JPEG", "a.png", "clip.MP4", "clip.mov"]) {
      expect(fileProblem({ name, size: 1000 }, 50 * MB), name).toBeNull();
    }
    expect(fileProblem({ name: "Talk.pdf", size: 50 * MB }, 50 * MB)).toBeNull();
  });

  it("refuses another extension, an empty file and one over the cap", () => {
    expect(fileProblem({ name: "Talk.ppt", size: 1000 }, 50 * MB)).toBe("type");
    expect(fileProblem({ name: "Talk.pptx.exe", size: 1000 }, 50 * MB)).toBe("type");
    expect(fileProblem({ name: "Talk.pdf", size: 0 }, 50 * MB)).toBe("empty");
    expect(fileProblem({ name: "Talk.pdf", size: 50 * MB + 1 }, 50 * MB)).toBe("large");
    expect(fileProblem({ name: "clip.mov", size: 90 * MB + 1 }, 90 * MB)).toBe("large");
  });

  it("takes a HEIC, in any case, as a photo to convert, whatever its size", () => {
    expect(fileProblem({ name: "IMG_0001.HEIC", size: 1000 }, 50 * MB)).toBeNull();
    expect(fileProblem({ name: "a.heif", size: 60 * MB }, 25 * MB)).toBeNull();
    expect(kindOf("IMG_0001.HEIC")).toBe("photo");
  });

  it("knows each kind by its name: a photo to compress, a video to clean, a file to send as it is", () => {
    expect(["a.jpg", "a.JPEG", "a.png", "a.heic"].map(kindOf)).toEqual(["photo", "photo", "photo", "photo"]);
    expect(["a.mp4", "a.MOV"].map(kindOf)).toEqual(["video", "video"]);
    expect(["a.pptx", "a.pdf"].map(kindOf)).toEqual(["file", "file"]);
    expect(["a.webp", "a.gif", "a.exe", "pptx"].map(kindOf)).toEqual([null, null, null, null]);
  });

  it("leaves a photo's size to its compression", () => {
    expect(fileProblem({ name: "a.jpg", size: 60 * MB }, 25 * MB)).toBeNull();
  });

  it("states the cap in whole megabytes", () => {
    expect(wholeMB(50 * MB)).toBe(50);
    expect(wholeMB(10 * MB)).toBe(10);
    expect(wholeMB(MB + 1)).toBe(1);
    expect(wholeMB(0)).toBe(1);
  });
});

const file = new File([new Uint8Array(10)], "Q3 plan: v2.pptx");

/** The engine as the adapter sees it: it reports states, the adapter turns them into the phone's result. */
function fakeEngine() {
  const made: { kind?: string; pid?: string; onChange: (b: unknown) => void }[] = [];
  const calls: string[] = [];
  const createUploader = (args: { kind: string; pid: string; onChange: (b: unknown) => void }) => {
    made.push(args);
    return {
      add: (files: File[]) => {
        calls.push(`add ${files[0]?.name}`);
        return [7];
      },
      cancel: (id: number) => calls.push(`cancel ${id}`),
      dispose: () => calls.push("dispose"),
    };
  };
  return { made, calls, createUploader };
}

async function start(onProgress: (fraction: number) => void = () => {}) {
  vi.resetModules();
  const engine = fakeEngine();
  vi.doMock("../../public/js/core/upload.js", () => ({ createUploader: engine.createUploader }));
  const { sendFile } = await import("../../public/js/core/drop.js");
  const sending = sendFile({ file, pid: "ref.secret", onProgress });
  await vi.waitFor(() => expect(engine.made).toHaveLength(1));
  const say = (state: string, more: object = {}) =>
    engine.made[0]?.onChange({ files: [{ id: 7, state, fraction: 0.5, ...more }] });
  return { ...engine, sending, say };
}

describe("sending a file", () => {
  afterEach(() => vi.doUnmock("../../public/js/core/upload.js"));

  it("hands the file to the engine as a guest with the pairing credential, and reports its share", async () => {
    const seen: number[] = [];
    const { made, calls, say } = await start((f) => seen.push(f));
    expect(made[0]).toMatchObject({ kind: "guest", pid: "ref.secret" });
    expect(calls).toEqual(["add Q3 plan: v2.pptx"]);
    say("uploading", { fraction: 0.25 });
    say("waiting", { fraction: 0.25 });
    expect(seen).toEqual([0.25, 0.25]);
  });

  it("resolves the pushed view when the engine says sent, and lets the engine go", async () => {
    const { sending, say, calls } = await start();
    say("sent", { view: { state: "offered" } });
    expect(await sending.done).toEqual({ ok: true, view: { state: "offered" } });
    expect(calls).toContain("dispose");
  });

  it("resolves the refusal's code, so the page can show the guest_refused state", async () => {
    const { sending, say } = await start();
    say("refused", { error: "bad_type" });
    expect(await sending.done).toEqual({ ok: false, error: "bad_type" });
  });

  it("abort cancels the engine's file, and its cancellation resolves upload_aborted", async () => {
    const { sending, say, calls } = await start();
    sending.abort();
    expect(calls).toContain("cancel 7");
    say("canceled");
    expect(await sending.done).toEqual({ ok: false, error: "upload_aborted" });
  });

  it("an abort before the engine loaded sends nothing", async () => {
    vi.resetModules();
    const engine = fakeEngine();
    vi.doMock("../../public/js/core/upload.js", () => ({ createUploader: engine.createUploader }));
    const { sendFile } = await import("../../public/js/core/drop.js");
    const sending = sendFile({ file, pid: "ref.secret", onProgress: () => {} });
    sending.abort();
    expect(await sending.done).toEqual({ ok: false, error: "upload_aborted" });
    expect(engine.made).toEqual([]);
  });

  it("an engine that cannot load says so in a toast with Reload, resolves offline and sends nothing", async () => {
    vi.resetModules();
    vi.doMock("../../public/js/core/upload.js", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const toasts: { title: string; body: string; action?: { label: string } }[] = [];
    vi.doMock("../../public/js/core/toast.js", () => ({ toast: (t: (typeof toasts)[number]) => toasts.push(t) }));
    const { sendFile } = await import("../../public/js/core/drop.js");
    const sending = sendFile({ file, pid: "ref.secret", onProgress: () => {} });
    expect(await sending.done).toEqual({ ok: false, error: "offline" });
    expect(toasts).toMatchObject([
      { title: "Upload Didn't Load", body: "Reload the page, then try again.", action: { label: "Reload" } },
    ]);
    vi.doUnmock("../../public/js/core/toast.js");
  });
});

describe("preparing a file", () => {
  const file = (bytes: number[], name: string) => new File([new Uint8Array(bytes)], name);

  it("sends a deck or PDF as it is", async () => {
    const deck = file([1, 2, 3], "a.pptx");
    expect(await prepareFile(deck, MB)).toEqual({ ok: true, file: deck });
  });

  it("refuses a video whose structure it cannot walk, with the video's problem", async () => {
    expect(await prepareFile(file([0, 0, 0, 12, 1, 2, 3], "a.mov"), MB)).toEqual({ ok: false, problem: "video" });
  });

  it("refuses a photo this browser cannot decode, small or not", async () => {
    expect(await prepareFile(file(new Array(200).fill(1), "a.png"), 100)).toEqual({ ok: false, problem: "photo" });
    expect(await prepareFile(file([0xff, 0xd8, 0xff, 0xda], "a.jpg"), MB)).toEqual({ ok: false, problem: "photo" });
  });

  it("names a HEIC this browser cannot decode, and never sends it as it is", async () => {
    expect(await prepareFile(file([0, 0, 0, 24], "IMG_1.HEIC"), MB)).toEqual({ ok: false, problem: "heic" });
  });

  /** Media modules whose photo step answers `reason`, and whose imports fail when `fail` names them. */
  const modules = (reason: "decode" | "encode" | "large", fail: ("photo" | "video")[] = []) => {
    const photo = { preparePhoto: async () => ({ ok: false as const, reason }) };
    const video = { stripLocation: async () => ({ ok: false as const }) };
    const load =
      <T>(name: "photo" | "video", m: T) =>
      async () => {
        if (fail.includes(name)) throw new TypeError("Failed to fetch dynamically imported module");
        return m;
      };
    return { photo: load("photo", photo), video: load("video", video) } as unknown as Parameters<typeof prepareFile>[2];
  };

  it("maps only a decode failure on a HEIC to heic: encode is photo, large is large", async () => {
    const heic = file([1], "a.heic");
    expect(await prepareFile(heic, MB, modules("decode"))).toEqual({ ok: false, problem: "heic" });
    expect(await prepareFile(heic, MB, modules("encode"))).toEqual({ ok: false, problem: "photo" });
    expect(await prepareFile(heic, MB, modules("large"))).toEqual({ ok: false, problem: "large" });
    expect(await prepareFile(file([1], "a.jpg"), MB, modules("decode"))).toEqual({ ok: false, problem: "photo" });
  });

  it("never rejects: a media module that fails to load is the file kind's refusal", async () => {
    const down = modules("decode", ["photo", "video"]);
    expect(await prepareFile(file([1], "a.jpg"), MB, down)).toEqual({ ok: false, problem: "photo" });
    expect(await prepareFile(file([1], "a.mov"), MB, down)).toEqual({ ok: false, problem: "video" });
    const deck = file([1], "a.pdf");
    expect(await prepareFile(deck, MB, down)).toEqual({ ok: true, file: deck });
  });
});
