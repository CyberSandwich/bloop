import { describe, expect, it } from "vitest";
import { fileProblem, kindOf, prepareFile, sendFile, wholeMB } from "../../public/js/core/drop.js";

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

class FakeXhr {
  headers: Record<string, string> = {};
  method = "";
  url = "";
  sent: unknown = null;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
  reply(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

const file = { name: "Q3 plan: v2.pptx", size: 10 };
const start = (xhr: FakeXhr, onProgress: (fraction: number) => void = () => {}) =>
  sendFile({ file, pid: "ref.secret", onProgress, xhr: () => xhr });

describe("sending a file", () => {
  it("PUTs the raw file to /api/drop with the credential and a percent-encoded name", () => {
    const xhr = new FakeXhr();
    start(xhr);
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("/api/drop");
    expect(xhr.headers).toEqual({
      Authorization: "Bearer ref.secret",
      "Content-Type": "application/octet-stream",
      "X-Bloop-Name": "Q3%20plan%3A%20v2.pptx",
    });
    expect(xhr.sent).toBe(file);
  });

  it("reports progress as a fraction, and ignores an unknown total", () => {
    const xhr = new FakeXhr();
    const seen: number[] = [];
    start(xhr, (f) => seen.push(f));
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    expect(seen).toEqual([0.25, 1]);
  });

  it("resolves the pushed view on success", async () => {
    const xhr = new FakeXhr();
    const { done } = start(xhr);
    xhr.reply(200, JSON.stringify({ state: "offered" }));
    expect(await done).toEqual({ ok: true, view: { state: "offered" } });
  });

  it("maps a refusal to its error code, so the page can show the guest_refused state", async () => {
    const xhr = new FakeXhr();
    const { done } = start(xhr);
    xhr.reply(415, JSON.stringify({ type: "about:blank", status: 415, code: "bad_type" }));
    expect(await done).toEqual({ ok: false, error: "bad_type" });
  });

  it("treats an unknown code as a bad request, and a 5xx or a non-JSON body as the service being down", async () => {
    const unknown = new FakeXhr();
    const a = start(unknown);
    unknown.reply(400, JSON.stringify({ code: "made_up" }));
    expect(await a.done).toEqual({ ok: false, error: "bad_request" });
    const down = new FakeXhr();
    const b = start(down);
    down.reply(502, "<html>bad gateway</html>");
    expect(await b.done).toEqual({ ok: false, error: "service_down" });
  });

  it("reports offline when the request fails, and upload_aborted when the page aborts it", async () => {
    const lost = new FakeXhr();
    const a = start(lost);
    lost.onerror?.();
    expect(await a.done).toEqual({ ok: false, error: "offline" });
    const stopped = new FakeXhr();
    const b = start(stopped);
    b.abort();
    expect(await b.done).toEqual({ ok: false, error: "upload_aborted" });
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

  it("refuses a photo that cannot be decoded and is over the cap", async () => {
    expect(await prepareFile(file(new Array(200).fill(1), "a.png"), 100)).toEqual({ ok: false, problem: "photo" });
  });

  it("names a HEIC this browser cannot decode, and never sends it as it is", async () => {
    expect(await prepareFile(file([0, 0, 0, 24], "IMG_1.HEIC"), MB)).toEqual({ ok: false, problem: "heic" });
  });
});
