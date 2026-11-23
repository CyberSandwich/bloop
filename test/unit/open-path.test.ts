import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LinkLedger } from "../../src/worker/do/ledger.ts";
import { policyOf, withHeaders } from "../../src/worker/headers.ts";
import type { Resolved, SourceContext } from "../../src/worker/seams/file-source/index.ts";
import { MockFileSource } from "../../src/worker/seams/file-source/mock.ts";
import type { LinkRecord } from "../../src/worker/seams/open-path/links.ts";
import { openPathFor } from "../../src/worker/seams/open-path/select.ts";

const HOSTS = ["*.sharepoint.com", "*.files.1drv.com"];
const BYTES = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
const GOOD_URL = "https://contoso-my.sharepoint.com/download?token=abc";

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

function resolved(over: Partial<Resolved> = {}): Resolved {
  return {
    name: "Deck.pptx",
    type: "pptx",
    size: BYTES.length,
    url: null,
    body: async () => ({ ok: true, stream: stream(BYTES), length: BYTES.length }),
    ...over,
  };
}

const req = (method = "GET", url = "https://bloop.test/f/t/n.pptx") => new Request(url, { method });
/** What the Worker sends: the handler's response with its chosen policy applied. */
const finished = (r: Response) => withHeaders(r, policyOf(r, "api"));

describe("RedirectOpenPath (the default)", () => {
  const open = openPathFor("redirect", HOSTS);

  it("answers 302 to the source's URL, which is the only Location it can send, with no body", async () => {
    const res = finished(await open.serve(req(), resolved({ url: GOOD_URL }), "protocol"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(GOOD_URL);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await res.text()).toBe("");
  });

  it("OPEN-04 redirect: a resolver that returns a foreign, plain-http or malformed host gets 502, never a Location", async () => {
    for (const url of [
      "https://evil.example/x.pptx",
      "http://x.sharepoint.com/x",
      "https://sharepoint.com.evil.test/",
      "//evil",
      "not a url",
    ]) {
      const res = await open.serve(req(), resolved({ url }), "protocol");
      expect(res.status).toBe(502);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("OPEN-04 redirect: nothing in the request reaches the Location (crafted path and query are ignored)", async () => {
    const crafted = req(
      "GET",
      "https://bloop.test/f/t/..%2F..%2Fhttps:%2F%2Fevil.example?next=https://evil.example&url=//evil",
    );
    const res = await open.serve(crafted, resolved({ url: GOOD_URL }), "download");
    expect(res.headers.get("Location")).toBe(GOOD_URL);
  });

  it("answers HEAD the same way, and streams when the source has no URL (mock, guest)", async () => {
    expect((await open.serve(req("HEAD"), resolved({ url: GOOD_URL }), "protocol")).status).toBe(302);
    const res = await open.serve(req(), resolved(), "protocol");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });
});

describe("StreamOpenPath", () => {
  const open = openPathFor("stream", HOSTS);

  it("streams the bytes with the type, length, attachment, sandbox CSP and no-store", async () => {
    const res = finished(await open.serve(req(), resolved({ url: GOOD_URL }), "download"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(res.headers.get("Content-Length")).toBe(String(BYTES.length));
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Location")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("OPEN-08 served-headers: the PDF view is inline under its own CSP, a PDF download is an attachment", async () => {
    const pdf = resolved({ name: "H.pdf", type: "pdf" });
    const view = finished(await open.serve(req(), pdf, "pdf"));
    expect(view.headers.get("Content-Type")).toBe("application/pdf");
    expect(view.headers.get("Content-Disposition")).toBe("inline");
    expect(view.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; object-src 'self'; frame-ancestors 'none'",
    );
    expect(view.headers.get("Cache-Control")).toBe("no-store");
    const download = finished(await open.serve(req(), pdf, "download"));
    expect(download.headers.get("Content-Disposition")).toBe("attachment");
    expect(download.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("HEAD carries the headers and the length from metadata, and opens no stream", async () => {
    let opened = false;
    const res = finished(
      await open.serve(
        req("HEAD"),
        resolved({
          body: async () => {
            opened = true;
            return { ok: false, error: "source_unavailable" };
          },
        }),
        "protocol",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(BYTES.length));
    expect(await res.text()).toBe("");
    expect(opened).toBe(false);
  });

  it("maps a source failure to 404 for a missing file and 502 for anything else", async () => {
    const failing = (error: "file_not_found" | "source_throttled" | "auth_required") =>
      resolved({ body: async () => ({ ok: false, error }) });
    expect((await open.serve(req(), failing("file_not_found"), "protocol")).status).toBe(404);
    expect((await open.serve(req(), failing("source_throttled"), "protocol")).status).toBe(502);
    expect((await open.serve(req(), failing("auth_required"), "protocol")).status).toBe(502);
  });

  it("the mock source serves its sample bytes in both modes", async () => {
    const sample = new Uint8Array(readFileSync(new URL("../fixtures/decks/sample-deck.pptx", import.meta.url)));
    const source = new MockFileSource([
      { id: "demo-deck", name: "Sample deck.pptx", type: "pptx", bytes: sample, editedMinutesAgo: 1, pdfId: null },
    ]);
    const ctx: SourceContext = {
      mode: "demo",
      userId: null,
      folderId: null,
      accessToken: async () => ({ ok: false, error: "auth_required" }),
    };
    const file = await source.resolve(ctx, "demo-deck");
    if (!file.ok) throw new Error("no demo deck");
    for (const mode of ["redirect", "stream"] as const) {
      const res = await openPathFor(mode, HOSTS).serve(req(), file.file, "protocol");
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length).toBe(file.file.size);
      expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    }
  });
});

describe("LinkLedger", () => {
  const limits = {
    firstFetchSeconds: 600,
    fetchWindowSeconds: 120,
    maxFetches: 3,
    maxMints: 5,
    binding: "log",
  } as const;
  const kv = () => {
    const map = new Map<string, unknown>();
    return { get: <T>(k: string) => map.get(k) as T | undefined, put: (k: string, v: unknown) => void map.set(k, v) };
  };
  const rec = (tokenHash: string): LinkRecord => ({
    tokenHash,
    purpose: "protocol",
    item: 0,
    mintedAt: 0,
    firstFetchAt: null,
    fetches: 0,
    revoked: false,
  });

  it("counts a fetch and fixes the window at the first one", () => {
    const ledger = new LinkLedger(kv());
    ledger.add(rec("a"));
    const first = ledger.use("a", 5000, limits, null);
    expect(first).toMatchObject({ ok: true, record: { fetches: 1, firstFetchAt: 5000 } });
    expect(ledger.use("a", 9000, limits, null)).toMatchObject({ ok: true, record: { fetches: 2, firstFetchAt: 5000 } });
  });

  it("refuses the fetch after the last allowed one and counts nothing for a refusal", () => {
    const ledger = new LinkLedger(kv());
    ledger.add(rec("a"));
    for (let i = 0; i < 3; i++) expect(ledger.use("a", 1000, limits, null).ok).toBe(true);
    expect(ledger.use("a", 1000, limits, null)).toEqual({ ok: false, error: "link_exhausted" });
    expect(ledger.use("a", 1000, limits, null)).toEqual({ ok: false, error: "link_exhausted" });
  });

  it("an unknown hash is link_unknown, and a refused binding does not count the fetch", () => {
    const ledger = new LinkLedger(kv());
    ledger.add(rec("a"));
    expect(ledger.use("zzz", 1, limits, null)).toEqual({ ok: false, error: "link_unknown" });
    expect(ledger.use("a", 1, limits, "link_binding_failed")).toEqual({ ok: false, error: "link_binding_failed" });
    expect(ledger.use("a", 1, limits, null)).toMatchObject({ ok: true, record: { fetches: 1 } });
  });

  it("revokeAll keeps tombstones: a real hash is revoked, a guess stays unknown", () => {
    const ledger = new LinkLedger(kv());
    ledger.add(rec("a"));
    ledger.add(rec("b"));
    expect(ledger.revokeAll()).toBe(2);
    expect(ledger.use("a", 1, limits, null)).toEqual({ ok: false, error: "link_revoked" });
    expect(ledger.use("c", 1, limits, null)).toEqual({ ok: false, error: "link_unknown" });
    expect(ledger.revokeAll()).toBe(0);
  });
});
