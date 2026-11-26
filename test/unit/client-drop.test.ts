import { describe, expect, it } from "vitest";
import { fileProblem, kindOf, prepareFile, sendFile, wholeMB } from "../../public/js/core/drop.js";
import { createUploader } from "../../public/js/core/upload.js";
import { makeWorld } from "./client-upload-world.ts";

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

/** The adapter over the real engine in a fake world on the guest routes; `view` answers the phone's view. */
function guestSend(options: { view?: () => Promise<any>; failLoad?: boolean } = {}) {
  const world = makeWorld({ mode: "proxy", pid: "ref.secret" });
  const seen: number[] = [];
  const views: string[] = [];
  const load = {
    upload: async () => {
      if (options.failLoad) throw new TypeError("Failed to fetch dynamically imported module");
      return {
        createUploader: (args: Parameters<typeof createUploader>[0]) =>
          createUploader({ ...args, deps: world.deps as never }),
      };
    },
    view: async (pid: string) => {
      views.push(pid);
      return options.view ? options.view() : { ok: true, value: { state: "offered" }, headers: new Headers() };
    },
  } as unknown as NonNullable<Parameters<typeof sendFile>[0]["load"]>;
  const sending = sendFile({
    file: world.file(50, "Q3 plan: v2.pptx"),
    pid: "ref.secret",
    onProgress: (f) => seen.push(f),
    load,
  });
  return { world, sending, seen, views };
}

describe("sending a file", () => {
  it("UP-09 goes through the upload engine on the guest routes, every request and part with the pid, never a member route", async () => {
    const { world, sending } = guestSend();
    await world.advance(0);
    expect(await sending.done).toEqual({ ok: true, view: { state: "offered" } });
    const paths = world.calledPaths();
    expect(paths).toContain("POST /api/guest/uploads");
    expect(paths).toContain("POST /api/guest/uploads/up1/complete");
    expect(paths.every((p) => p.includes("/api/guest/uploads"))).toBe(true);
    for (const call of world.calls) expect(call.headers.Authorization).toBe("Bearer ref.secret");
    expect(world.puts.length).toBe(3);
    for (const put of world.puts) {
      expect(put.url).toMatch(/^\/api\/guest\/uploads\/up1\/parts\/\d$/);
      expect(put.headers.Authorization).toBe("Bearer ref.secret");
    }
  });

  it("reports the file's fill while its parts move, and answers the phone's view once it is ready", async () => {
    const { world, sending, seen, views } = guestSend();
    world.onPut = (put) => {
      put.progress(10);
      put.ok();
    };
    await world.advance(0);
    expect((await sending.done).ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f, i) => f >= 0 && f < 1 && (i === 0 || f >= (seen[i - 1] ?? 0)))).toBe(true);
    expect(views).toEqual(["ref.secret"]);
  });

  it("maps the server's refusal of the file to its code, so the page can show the guest_refused state", async () => {
    const { world, sending } = guestSend();
    world.intercept.push((c) =>
      c.path.endsWith("/complete")
        ? world.json(200, { state: "refused", file: { id: "f1", status: "refused", refusal: "bad_type" } })
        : undefined,
    );
    await world.advance(0);
    expect(await sending.done).toEqual({ ok: false, error: "bad_type" });
  });

  it("names a create refusal by its code, and the engine's own codes as the service being down", async () => {
    const a = guestSend();
    a.world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/guest/uploads" ? a.world.problem(413, "too_large") : undefined,
    );
    await a.world.advance(0);
    expect(await a.sending.done).toEqual({ ok: false, error: "too_large" });
    const b = guestSend();
    b.world.intercept.push((c) =>
      c.method === "POST" && c.path === "/api/guest/uploads" ? b.world.problem(409, "upload_busy") : undefined,
    );
    await b.world.advance(0);
    expect(await b.sending.done).toEqual({ ok: false, error: "service_down" });
  });

  it("answers upload_aborted when the page aborts it, and closes the upload on the server", async () => {
    const { world, sending } = guestSend();
    world.onPut = () => {};
    await world.advance(0);
    sending.abort();
    expect(await sending.done).toEqual({ ok: false, error: "upload_aborted" });
    await world.advance(0);
    expect(world.calledPaths("DELETE")).toEqual(["DELETE /api/guest/uploads/up1"]);
  });

  it("reports offline when the engine cannot load or the view cannot be read", async () => {
    const down = guestSend({ failLoad: true });
    expect(await down.sending.done).toEqual({ ok: false, error: "offline" });
    const lost = guestSend({ view: async () => ({ ok: false, error: "offline" }) });
    await lost.world.advance(0);
    expect(await lost.sending.done).toEqual({ ok: false, error: "offline" });
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
