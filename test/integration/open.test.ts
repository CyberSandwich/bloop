// The open path end to end against `wrangler dev` with the default config (redirect mode, mock source,
// limits of 10 fetches and 5 extra mints). Short link lifetimes live in open-timing.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveDemo, fetchLink, PROTOCOL_PREFIX, problemOf } from "./open-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing();
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("mint at approve", () => {
  it("pushes one open frame to the screen with an ms-powerpoint URI over a short /f/ link, and nothing else in it", async () => {
    const { socket, links, url } = await approveDemo(api);
    expect(links.protocol).toBe(`${PROTOCOL_PREFIX}${url}`);
    expect(links.download).toBeNull();
    expect(links.pdf).toBeNull();
    expect(url).toMatch(new RegExp(`^${wrangler.url}/f/[A-Za-z0-9_-]{54}/Sample-deck\\.pptx$`));
    expect(url.length).toBeLessThanOrEqual(200);
    expect(links.protocol?.length).toBeLessThanOrEqual(256);
    // never repeated in a state frame
    const states = socket.frames.filter((f) => f.t === "state");
    expect(JSON.stringify(states)).not.toContain("/f/");
    socket.close();
  });

  it("the screen's launched report moves approved to opening, and the first fetch opens it for both sides", async () => {
    const { socket, pid, url } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    await socket.stateWhere((v) => v.state === "opening" && v.openMode === "protocol");
    const res = await fetchLink(url);
    expect(res.status).toBe(200);
    await socket.stateWhere((v) => v.state === "open");
    const phone = await api.get<{ state: string }>("/api/pair/state", pid);
    expect(phone.body.state).toBe("open");
    socket.close();
  });
});

describe("a fetch", () => {
  it("serves the mock deck's bytes with no-store, nosniff and the attachment headers, whatever the query", async () => {
    const { socket, url } = await approveDemo(api);
    const res = await fetchLink(`${url}?OR=ProtocolHandler&CID=abc`, {
      headers: { "User-Agent": "Microsoft Office PowerPoint/16.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(PPTX);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Number(res.headers.get("Content-Length"))).toBe(bytes.length);
    socket.close();
  });

  it("OPEN-01 link-life: the name segment is ignored, so any name works inside the window", async () => {
    const { socket, url } = await approveDemo(api);
    const other = url.replace(/\/[^/]+$/, "/anything-else.pptx");
    expect((await fetchLink(other)).status).toBe(200);
    socket.close();
  });

  it("answers HEAD with the same headers and no body", async () => {
    const { socket, url } = await approveDemo(api);
    const res = await fetchLink(url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(PPTX);
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(0);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("");
    socket.close();
  });

  it("OPEN-07 methods: OPTIONS, PROPFIND and every write get 405 with Allow: GET, HEAD, and cost no fetch", async () => {
    const { socket, url } = await approveDemo(api);
    for (const method of ["OPTIONS", "PROPFIND", "PUT", "POST", "DELETE", "PATCH", "MKCOL"]) {
      const res = await fetchLink(url, { method, ...(method === "POST" || method === "PUT" ? { body: "x" } : {}) });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow"), method).toBe("GET, HEAD");
      expect((await problemOf(res)).code).toBe("method_not_allowed");
    }
    // ten real fetches are still available
    for (let i = 0; i < 10; i++) expect((await fetchLink(url)).status).toBe(200);
    socket.close();
  });

  it("OPEN-01 link-life: the 10th fetch works and the 11th is gone (link_exhausted, 410)", async () => {
    const { socket, url } = await approveDemo(api);
    for (let i = 0; i < 10; i++) expect((await fetchLink(url)).status, `fetch ${i + 1}`).toBe(200);
    const eleventh = await fetchLink(url);
    expect(eleventh.status).toBe(410);
    expect((await problemOf(eleventh)).code).toBe("link_exhausted");
    expect(eleventh.headers.get("Cache-Control")).toBe("no-store");
    socket.close();
  });
});

describe("the fetch log (field test T3)", () => {
  it("writes one line per request with the method, client class, query and status, and never the token", async () => {
    const { socket, url } = await approveDemo(api);
    await fetchLink(`${url}?OR=ProtocolHandler`, { headers: { "User-Agent": "Microsoft Office PowerPoint/16.0" } });
    await fetchLink(url, { method: "PROPFIND" });
    const token = url.split("/f/")[1]?.split("/")[0] ?? "";
    const lines = wrangler
      .output()
      .split("\n")
      .filter((l) => l.includes('"evt":"open.fetch"'));
    const parsed = lines.map((l) => JSON.parse(l.slice(l.indexOf("{"))));
    expect(parsed).toContainEqual({
      evt: "open.fetch",
      method: "GET",
      client: "office",
      query: true,
      range: false,
      status: 200,
    });
    expect(parsed).toContainEqual({
      evt: "open.fetch",
      method: "PROPFIND",
      client: "other",
      query: false,
      range: false,
      status: 405,
    });
    // wrangler's own request line shows the URL; the Worker's lines never do
    expect(lines.join("\n")).not.toContain(token);
    socket.close();
  });
});

describe("unknown and malformed tokens", () => {
  it("OPEN-01 link-life: a token that never existed answers the same 404 as a malformed one, and says nothing else", async () => {
    const ghost = `${wrangler.url}/f/${"A".repeat(22)}${"b".repeat(32)}/x.pptx`;
    const malformed = `${wrangler.url}/f/not-a-token/x.pptx`;
    const a = await fetchLink(ghost);
    const b = await fetchLink(malformed);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    expect(await problemOf(await fetchLink(ghost))).toEqual({ type: "about:blank", status: 404, code: "link_unknown" });
  });

  it("a real screen ref with a wrong secret is the same 404, not a hint that the screen exists", async () => {
    const { socket, url, screen } = await approveDemo(api);
    const wrong = `${wrangler.url}/f/${screen.ref}${"c".repeat(32)}/x.pptx`;
    const res = await fetchLink(wrong);
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("link_unknown");
    expect((await fetchLink(url)).status).toBe(200);
    socket.close();
  });

  it("OPEN-04 redirect: a crafted path or query never produces a Location, and a path that is not /f/<token>/<name> is 404", async () => {
    const { socket, url } = await approveDemo(api);
    const crafted = [
      url.replace(/\/[^/]+$/, "/..%2F..%2Fhttps:%2F%2Fevil.example"),
      `${url}?next=https://evil.example&url=//evil.example&redirect=https://evil.example`,
      `${wrangler.url}/f//evil.example/x`,
      `${wrangler.url}/f/https:%2F%2Fevil.example/x.pptx`,
      `${wrangler.url}/f/${url.split("/f/")[1]}/extra/segment`,
    ];
    for (const target of crafted) {
      const res = await fetchLink(target);
      expect(res.headers.get("Location"), target).toBeNull();
      expect([200, 404], target).toContain(res.status);
    }
    socket.close();
  });
});

describe("fallback links", () => {
  const link = (auth: string, purpose: string) =>
    api.post<{ links: { protocol: string | null; download: string | null; pdf: string | null } }>(
      "/api/screen/link",
      { purpose },
      { auth },
    );

  it("a download link is an attachment, a PDF link is the inline view, and each moves the open mode both sides see", async () => {
    const { socket, screen, pid } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    await socket.stateWhere((v) => v.state === "opening");

    const download = await link(screen.sid, "download");
    expect(download.status).toBe(200);
    expect(download.body.links.protocol).toBeNull();
    const dl = await fetchLink(download.body.links.download as string);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Disposition")).toBe("attachment");
    await socket.stateWhere((v) => v.state === "open" && v.openMode === "download");
    expect((await api.get<{ openMode: string }>("/api/pair/state", pid)).body.openMode).toBe("download");

    const pdf = await link(screen.sid, "pdf");
    const view = await fetchLink(pdf.body.links.pdf as string);
    expect(view.status).toBe(200);
    expect(view.headers.get("Content-Type")).toBe("application/pdf");
    expect(view.headers.get("Content-Disposition")).toBe("inline");
    expect(view.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; object-src 'self'; frame-ancestors 'none'",
    );
    expect(view.headers.get("Cache-Control")).toBe("no-store");
    expect(new TextDecoder().decode((await view.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    // the new links arrived as open frames as well
    await socket.waitFor((f) => f.t === "open" && (f.links as { pdf: string | null }).pdf !== null);
    socket.close();
  });

  it("limits a session to five extra links, then answers mint_limit", async () => {
    const { socket, screen } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    await socket.stateWhere((v) => v.state === "opening");
    for (let i = 0; i < 5; i++) expect((await link(screen.sid, "download")).status).toBe(200);
    const sixth = await link(screen.sid, "download");
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ code: "mint_limit" });
    socket.close();
  });

  it("refuses a download or PDF link before the launch, but gives an approved screen its protocol link again", async () => {
    const { socket, screen, url } = await approveDemo(api);
    expect((await link(screen.sid, "download")).status).toBe(409);
    const again = await link(screen.sid, "protocol");
    expect(again.status).toBe(200);
    expect(again.body.links.protocol).toMatch(/^ms-powerpoint:ofv\|u\|/);
    expect(again.body.links.protocol).not.toContain(url);
    socket.close();
  });

  it("checks the credential, the origin and the body", async () => {
    const { socket, screen, pid } = await approveDemo(api);
    expect((await api.post("/api/screen/link", { purpose: "download" })).status).toBe(401);
    expect((await link(pid, "download")).status).toBe(401);
    expect((await api.post("/api/screen/link", { purpose: "x" }, { auth: screen.sid })).status).toBe(400);
    expect(
      (await api.post("/api/screen/link", { purpose: "pdf" }, { auth: screen.sid, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    socket.close();
  });
});

describe("end", () => {
  it("OPEN-01 link-life: after the phone ends the session every link is gone (410 link_revoked), tokens that never existed stay 404", async () => {
    const { socket, screen, pid, url } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    await socket.stateWhere((v) => v.state === "opening");
    const dl = await api.post<{ links: { download: string } }>(
      "/api/screen/link",
      { purpose: "download" },
      { auth: screen.sid },
    );
    expect((await fetchLink(url)).status).toBe(200);

    expect((await api.post("/api/end", {}, { auth: pid })).status).toBe(200);
    for (const gone of [url, dl.body.links.download]) {
      const res = await fetchLink(gone);
      expect(res.status).toBe(410);
      expect((await problemOf(res)).code).toBe("link_revoked");
    }
    const ghost = await fetchLink(`${wrangler.url}/f/${screen.ref}${"d".repeat(32)}/x.pptx`);
    expect(ghost.status).toBe(404);
    socket.close();
  });

  it("RES-01 residue: the screen's own end revokes the links and answers with Clear-Site-Data", async () => {
    const { socket, screen, url } = await approveDemo(api);
    const ended = await api.post("/api/screen/end", {}, { auth: screen.sid });
    expect(ended.status).toBe(200);
    expect(ended.headers.get("Clear-Site-Data")).toBe('"storage"');
    expect((await fetchLink(url)).status).toBe(410);
    // and a new link cannot be minted after the end
    const after = await api.post("/api/screen/link", { purpose: "download" }, { auth: screen.sid });
    expect(after.status).toBe(409);
    socket.close();
  });
});
