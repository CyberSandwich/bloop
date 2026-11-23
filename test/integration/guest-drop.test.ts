// The guest drop against `wrangler dev` with a local R2 bucket and D1: a full drop to the Open click, the refusals,
// and the deletion paths. Short timers and the budget live in guest-drop-timing.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip, concat, validDeck, validPdf } from "../zip-builder.ts";
import { guestRow, pairPhone, problemCode, putDrop } from "./drop-client.ts";
import { fetchLink } from "./open-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
const MAX = 20_000;
beforeAll(async () => {
  wrangler = await startPairing({ GUEST_MAX_BYTES: String(MAX) }, { migrate: true });
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const deck = validDeck();
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("DROP-06 open-click: a guest drop waits for the click on the screen", () => {
  it("offers the upload, mints nothing until the Open click, serves it from R2 over /f/, then deletes it at End", async () => {
    const { screen, socket, pid } = await pairPhone(api);
    const res = await putDrop(api, pid, deck, { name: "Talk.pptx" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "offered", kind: "guest", fileName: "Talk.pptx" });

    const offered = await socket.stateWhere((v) => v.state === "offered");
    expect(offered.view).toMatchObject({
      kind: "guest",
      fileName: "Talk.pptx",
      fileSize: deck.length,
      openMode: null,
      endsAt: null,
    });
    expect(socket.frames.some((f) => f.t === "open")).toBe(false);

    const row = guestRow(wrangler.d1);
    expect(row).toMatchObject({ bytes: deck.length, type: "pptx", name: "Talk.pptx", deleted_at: null });
    expect(String(row?.r2_key)).toMatch(/^g\/[A-Za-z0-9_-]{22}$/);
    expect(String(row?.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(wrangler.r2Has(String(row?.r2_key))).toBe(true);

    // The screen's own click is the only thing that opens it.
    socket.send({ t: "open.click" });
    const open = await socket.waitFor((f) => f.t === "open");
    const url = ((open.links as { protocol: string }).protocol ?? "").replace("ms-powerpoint:ofv|u|", "");
    const fetched = await fetchLink(url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("Content-Type")).toBe(PPTX);
    expect(fetched.headers.get("Content-Disposition")).toBe("attachment");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(deck);

    const ended = await api.post<{ state: string }>("/api/end", {}, { auth: pid });
    expect(ended.body.state).toBe("ended");
    expect((await fetchLink(url)).status).toBe(410);
    expect(guestRow(wrangler.d1)?.deleted_at).not.toBeNull();
    expect(wrangler.r2Has(String(row?.r2_key))).toBe(false);
    expect(screen.ref).toBeTruthy();
    socket.close();
  }, 60_000);

  it("a phone that scanned as an owner can still send a file: the drop turns it into a guest", async () => {
    const { socket, pid } = await pairPhone(api, "owner");
    const res = await putDrop(api, pid, validPdf(), { name: "Notes.pdf" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "offered", kind: "guest", fileName: "Notes.pdf" });
    socket.close();
  });

  it("a PDF drop is served inline as a PDF after the click", async () => {
    const { socket, pid } = await pairPhone(api);
    const pdf = validPdf();
    expect((await putDrop(api, pid, pdf, { name: "Notes.pdf" })).status).toBe(200);
    socket.send({ t: "open.click" });
    const open = await socket.waitFor((f) => f.t === "open");
    const links = open.links as { protocol: string | null; pdf: string | null };
    expect(links.protocol).toBeNull();
    expect(links.pdf).toMatch(/\/Notes\.pdf$/);
    const res = await fetchLink(links.pdf ?? "");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
    socket.close();
  });
});

describe("DROP-07 deletion at the end of a session", () => {
  it("Start Over on the screen deletes the offered object", async () => {
    const { screen, socket, pid } = await pairPhone(api);
    await putDrop(api, pid, deck);
    const key = String(guestRow(wrangler.d1)?.r2_key);
    expect(wrangler.r2Has(key)).toBe(true);
    const restarted = await api.post("/api/screen/restart", {}, { auth: screen.sid });
    expect(restarted.status).toBe(200);
    expect(wrangler.r2Has(key)).toBe(false);
    expect(guestRow(wrangler.d1)?.deleted_at).not.toBeNull();
    socket.close();
  });

  it("the phone's Cancel deletes the offered object", async () => {
    const { socket, pid } = await pairPhone(api);
    await putDrop(api, pid, deck);
    const key = String(guestRow(wrangler.d1)?.r2_key);
    expect((await api.post("/api/cancel", {}, { auth: pid })).status).toBe(200);
    expect(wrangler.r2Has(key)).toBe(false);
    socket.close();
  });

  it("the End on the screen deletes it after an opened drop", async () => {
    const { screen, socket, pid } = await pairPhone(api);
    await putDrop(api, pid, deck);
    const key = String(guestRow(wrangler.d1)?.r2_key);
    socket.send({ t: "open.click" });
    await socket.waitFor((f) => f.t === "open");
    expect((await api.post("/api/screen/end", {}, { auth: screen.sid })).status).toBe(200);
    expect(wrangler.r2Has(key)).toBe(false);
    expect(pid).toBeTruthy();
    socket.close();
  });
});

describe("DROP-01 size", () => {
  it("refuses a declared length over GUEST_MAX_BYTES before reading, and leaves the session able to send again", async () => {
    const { socket, pid } = await pairPhone(api);
    const res = await putDrop(api, pid, new Uint8Array(MAX + 1));
    expect(res.status).toBe(413);
    expect(await problemCode(res)).toBe("too_large");
    expect((await putDrop(api, pid, deck)).status).toBe(200);
    socket.close();
  });

  it("refuses a body with no Content-Length (chunked)", async () => {
    const { socket, pid } = await pairPhone(api);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(deck);
        c.close();
      },
    });
    const res = await fetch(`${api.base}/api/drop`, {
      method: "PUT",
      headers: {
        Origin: api.base,
        Authorization: `Bearer ${pid}`,
        "Content-Type": "application/octet-stream",
        "X-Bloop-Name": "Talk.pptx",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(411);
    expect(await problemCode(res)).toBe("length_required");
    socket.close();
  });
});

describe("DROP-02 wrong type and polyglot are refused and nothing is kept", () => {
  const cases: [string, Uint8Array, string, string, number][] = [
    [
      "a renamed executable",
      concat([new TextEncoder().encode("MZ"), new Uint8Array(400)]),
      "Talk.pptx",
      "bad_type",
      415,
    ],
    ["a deck sent as a .pdf", deck, "Talk.pdf", "bad_type", 415],
    ["a name with no allowed extension", deck, "Talk.exe", "bad_type", 415],
    [
      "a zip with no ppt parts",
      buildZip([{ name: "word/document.xml", data: "<w/>" }]),
      "Talk.pptx",
      "bad_structure",
      422,
    ],
    ["a PDF that ends in a zip", concat([validPdf(), deck]), "Talk.pdf", "bad_structure", 422],
    [
      "a deck with a macro part",
      validDeck([{ name: "ppt/vbaProject.bin", data: "x" }]),
      "Talk.pptx",
      "macro_content",
      422,
    ],
  ];
  for (const [label, bytes, name, code, status] of cases) {
    it(`DROP-02 ${label}: ${code}`, async () => {
      const { socket, pid } = await pairPhone(api);
      const res = await putDrop(api, pid, bytes, { name });
      expect(res.status).toBe(status);
      expect(await problemCode(res)).toBe(code);
      const phone = await api.get<{ state: string }>("/api/pair/state", pid);
      expect(phone.body.state).toBe("claimed");
      socket.close();
    });
  }

  it("DROP-02 leaves no object behind after a refusal", async () => {
    const { socket, pid } = await pairPhone(api);
    await putDrop(api, pid, concat([new TextEncoder().encode("MZ"), new Uint8Array(400)]));
    const row = guestRow(wrangler.d1);
    // A refusal before any byte is read (wrong extension) reserves nothing; this one reserved, stored, then deleted.
    expect(row?.deleted_at).not.toBeNull();
    expect(wrangler.r2Has(String(row?.r2_key))).toBe(false);
    socket.close();
  });

  it("refuses a declared type the browser would not send", async () => {
    const { socket, pid } = await pairPhone(api);
    const res = await putDrop(api, pid, deck, { contentType: "text/html" });
    expect(res.status).toBe(415);
    expect(await problemCode(res)).toBe("unsupported_media_type");
    socket.close();
  });

  it("DROP-08 xss: a hostile name is stored as text and the path keeps no markup", async () => {
    const { socket, pid } = await pairPhone(api);
    const name = "<img src=x onerror=alert(1)>‮.pptx";
    const res = await putDrop(api, pid, deck, { name });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { fileName: string };
    expect(view.fileName).not.toContain("‮");
    socket.send({ t: "open.click" });
    const open = await socket.waitFor((f) => f.t === "open");
    expect((open.links as { protocol: string }).protocol).toMatch(/\/f\/[A-Za-z0-9_-]{54}\/[A-Za-z0-9.-]+$/);
    socket.close();
  });
});

describe("DROP-05 one file per session", () => {
  it("refuses a second file once one is offered, and the first stays", async () => {
    const { socket, pid } = await pairPhone(api);
    expect((await putDrop(api, pid, deck, { name: "One.pptx" })).status).toBe(200);
    const second = await putDrop(api, pid, deck, { name: "Two.pptx" });
    expect(second.status).toBe(409);
    expect(await problemCode(second)).toBe("already_uploaded");
    const phone = await api.get<{ state: string; fileName: string }>("/api/pair/state", pid);
    expect(phone.body).toMatchObject({ state: "offered", fileName: "One.pptx" });
    socket.close();
  });

  it("refuses two uploads that start together: one wins", async () => {
    const { socket, pid } = await pairPhone(api);
    const both = await Promise.all([putDrop(api, pid, deck), putDrop(api, pid, deck)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    socket.close();
  });
});

describe("DROP-09 access: a guest file is visible only inside its session", () => {
  it("has no list route and no read route, and a key is no token", async () => {
    const { socket, pid } = await pairPhone(api);
    await putDrop(api, pid, deck);
    const key = String(guestRow(wrangler.d1)?.r2_key);
    for (const path of ["/api/drop", "/api/files", "/api/guest-files", `/${key}`, `/f/${key.slice(2)}/Talk.pptx`]) {
      const res = await fetch(`${api.base}${path}`, { headers: { Authorization: `Bearer ${pid}` } });
      expect([404, 405, 409]).toContain(res.status);
    }
    expect((await fetchLink(`${api.base}/f/${"A".repeat(54)}/Talk.pptx`)).status).toBe(404);
    socket.close();
  });

  it("DROP-09 another session's link does not read this session's file", async () => {
    const one = await pairPhone(api);
    const two = await pairPhone(api);
    await putDrop(api, one.pid, deck, { name: "One.pptx" });
    await putDrop(api, two.pid, validPdf(), { name: "Two.pdf" });
    one.socket.send({ t: "open.click" });
    const open = await one.socket.waitFor((f) => f.t === "open");
    const url = ((open.links as { protocol: string }).protocol ?? "").replace("ms-powerpoint:ofv|u|", "");
    // A token from session one with another screen's ref spliced in is an unknown token.
    const refTwo = two.screen.ref;
    const spliced = url.replace(/\/f\/[A-Za-z0-9_-]{22}/, `/f/${refTwo}`);
    expect((await fetchLink(spliced)).status).toBe(404);
    one.socket.close();
    two.socket.close();
  });

  it("DROP-09 an upload with another session's credential is refused", async () => {
    const one = await pairPhone(api);
    const two = await pairPhone(api);
    const secretOne = one.pid.split(".")[1];
    const forged = `${two.screen.ref}.${secretOne}`;
    const res = await putDrop(api, forged, deck);
    expect(res.status).toBe(401);
    expect(await problemCode(res)).toBe("pairing_invalid");
    expect((await api.get<{ state: string }>("/api/pair/state", two.pid)).body.state).toBe("claimed");
    const noAuth = await putDrop(api, null, deck);
    expect(noAuth.status).toBe(401);
    one.socket.close();
    two.socket.close();
  });

  it("an upload to an ended session is refused", async () => {
    const { socket, pid } = await pairPhone(api);
    await api.post("/api/cancel", {}, { auth: pid });
    const res = await putDrop(api, pid, deck);
    expect([401, 410]).toContain(res.status);
    socket.close();
  });
});

describe("PAIR-06 csrf on the drop", () => {
  it("refuses a cross-origin upload, a missing Origin and a cross-site fetch, and stores nothing", async () => {
    const { socket, pid } = await pairPhone(api);
    const before = wrangler.d1("SELECT COUNT(*) AS n FROM guest_file")[0]?.n;
    const foreign = await putDrop(api, pid, deck, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await problemCode(foreign)).toBe("forbidden_origin");
    expect((await putDrop(api, pid, deck, { origin: null })).status).toBe(403);
    const site = await putDrop(api, pid, deck, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(site.status).toBe(403);
    expect(wrangler.d1("SELECT COUNT(*) AS n FROM guest_file")[0]?.n).toBe(before);
    // the session is untouched and still takes a file
    expect((await putDrop(api, pid, deck)).status).toBe(200);
    socket.close();
  });

  it("only PUT reaches the route", async () => {
    const res = await fetch(`${api.base}/api/drop`, { method: "POST", headers: { Origin: api.base } });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT");
  });
});
