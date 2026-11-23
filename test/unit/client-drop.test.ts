import { describe, expect, it } from "vitest";
import { sendable, sendFile, wholeMB } from "../../public/js/core/drop.js";

const MB = 1024 * 1024;

describe("what a phone can check before sending", () => {
  it("accepts a .pptx or .pdf within the cap, in any case", () => {
    expect(sendable({ name: "Talk.pptx", size: 1000 }, 50 * MB)).toBe(true);
    expect(sendable({ name: "NOTES.PDF", size: 50 * MB }, 50 * MB)).toBe(true);
  });

  it("refuses another extension, an empty file and one over the cap", () => {
    expect(sendable({ name: "Talk.ppt", size: 1000 }, 50 * MB)).toBe(false);
    expect(sendable({ name: "Talk.pptx.exe", size: 1000 }, 50 * MB)).toBe(false);
    expect(sendable({ name: "Talk.pdf", size: 0 }, 50 * MB)).toBe(false);
    expect(sendable({ name: "Talk.pdf", size: 50 * MB + 1 }, 50 * MB)).toBe(false);
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
