import { afterEach, describe, expect, it, vi } from "vitest";

// A specifier in a variable: the node tsconfig has no DOM lib, so it must not follow drop.js into the pill's page code.
const DROP = "../../public/js/core/drop.js";
interface Drop {
  fileProblem: (file: { name: string; size: number }, maxBytes: number) => string | null;
  kindOf: (name: string) => string | null;
  wholeMB: (bytes: number) => number;
  sendFile: (args: { file: File; pid: string; onProgress: (fraction: number) => void }) => {
    done: Promise<unknown>;
    abort: () => void;
  };
}
const { fileProblem, kindOf, wholeMB } = (await import(DROP)) as Drop;

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
const PILL = "../../public/js/core/upload-pill.js";
const TOAST = "../../public/js/core/toast.js";

/** The binding as the adapter sees it: it reports snapshots, the adapter turns them into the phone's result. */
function fakeBinding() {
  const made: { kind?: string; pid?: string; onChange: (b: unknown) => void }[] = [];
  const calls: string[] = [];
  const mountUploads = async (args: { kind: string; pid: string; onChange: (b: unknown) => void }) => {
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
  return { made, calls, mountUploads };
}

async function start(onProgress: (fraction: number) => void = () => {}) {
  vi.resetModules();
  const binding = fakeBinding();
  vi.doMock(PILL, () => ({ mountUploads: binding.mountUploads }));
  const { sendFile } = (await import(DROP)) as Drop;
  const sending = sendFile({ file, pid: "ref.secret", onProgress });
  await vi.waitFor(() => expect(binding.calls).toContain("add Q3 plan: v2.pptx"));
  const say = (state: string, more: object = {}) =>
    binding.made[0]?.onChange({ files: [{ id: 7, state, fraction: 0.5, ...more }] });
  return { ...binding, sending, say };
}

describe("sending a file", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock(PILL);
    vi.doUnmock(TOAST);
  });

  it("mounts the pill as a guest with the pairing credential, adds the file, and reports its share", async () => {
    const seen: number[] = [];
    const { made, calls, say } = await start((f) => seen.push(f));
    expect(made[0]).toMatchObject({ kind: "guest", pid: "ref.secret" });
    expect(calls).toEqual(["add Q3 plan: v2.pptx"]);
    say("uploading", { fraction: 0.25 });
    say("waiting", { fraction: 0.25 });
    expect(seen).toEqual([0.25, 0.25]);
  });

  it("resolves the pushed view when sent, and keeps the pill up for 2 s so Sent is read", async () => {
    vi.useFakeTimers();
    const { sending, say, calls } = await start();
    say("sent", { view: { state: "offered" } });
    expect(await sending.done).toEqual({ ok: true, view: { state: "offered" } });
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).not.toContain("dispose");
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toContain("dispose");
  });

  it("resolves the refusal's code and takes the pill down at once, so the page's own state is the only message", async () => {
    vi.useFakeTimers();
    const { sending, say, calls } = await start();
    say("refused", { error: "bad_type" });
    expect(await sending.done).toEqual({ ok: false, error: "bad_type" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("dispose");
  });

  it("abort cancels the file, and its cancellation resolves upload_aborted", async () => {
    const { sending, say, calls } = await start();
    sending.abort();
    expect(calls).toContain("cancel 7");
    say("canceled");
    expect(await sending.done).toEqual({ ok: false, error: "upload_aborted" });
  });

  it("an abort before the pill loaded sends nothing", async () => {
    vi.resetModules();
    const binding = fakeBinding();
    vi.doMock(PILL, () => ({ mountUploads: binding.mountUploads }));
    const { sendFile } = (await import(DROP)) as Drop;
    const sending = sendFile({ file, pid: "ref.secret", onProgress: () => {} });
    sending.abort();
    expect(await sending.done).toEqual({ ok: false, error: "upload_aborted" });
    expect(binding.calls).not.toContain("add Q3 plan: v2.pptx");
  });

  it("a pill that cannot load says so in a toast with Reload, resolves offline and sends nothing", async () => {
    vi.resetModules();
    vi.doMock(PILL, () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const toasts: { title: string; body: string; action?: { label: string } }[] = [];
    vi.doMock(TOAST, () => ({ toast: (t: (typeof toasts)[number]) => toasts.push(t) }));
    const { sendFile } = (await import(DROP)) as Drop;
    const sending = sendFile({ file, pid: "ref.secret", onProgress: () => {} });
    expect(await sending.done).toEqual({ ok: false, error: "offline" });
    expect(toasts).toMatchObject([
      { title: "Upload Didn't Load", body: "Reload the page, then try again.", action: { label: "Reload" } },
    ]);
  });
});
