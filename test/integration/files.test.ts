// /api/files and approve against the default mock source, and the OAuth routes while Entra is not configured.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_IDS, DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import { Api, claim, openScreen, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing();
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

const problem = (code: string) => expect.objectContaining({ code });
/** A catalog file as an approved session lists it: its slot id and its name. */
const slotted = (item: { slot: string; name: string }) => ({ id: item.slot, name: item.name });
interface Files {
  items: (
    | { kind: "file"; id: string; name: string; type: string; modifiedAt: number; size: number | null }
    | {
        kind: "link";
        id: string;
        url: string;
        title: string;
      }
  )[];
}

/** A paired owner phone on a screen of the given mode. */
async function paired(mode: "demo" | "live") {
  const { screen, socket, code } = await openScreen(api, mode);
  const claimed = await claim(api, code);
  return { screen, socket, pid: claimed.body.pid };
}

describe("GET /api/files with the mock source", () => {
  it("SRC-04 isolation: a demo screen lists the demo catalog, files by name then links, in the documented shape", async () => {
    const { socket, pid } = await paired("demo");
    const res = await api.get<Files>("/api/files", pid);
    expect(res.status).toBe(200);
    expect(res.body.items.map((f) => f.id)).toEqual(DEMO_IDS);
    for (const f of res.body.items) {
      if (f.kind === "link") {
        expect(f).toEqual({ kind: "link", id: DEMO_ITEMS.link.id, url: "https://www.vevox.com/", title: "Vevox" });
        continue;
      }
      expect(Object.keys(f).sort()).toEqual(["id", "kind", "modifiedAt", "name", "size", "type"]);
      expect(f.modifiedAt).toBeLessThanOrEqual(Date.now());
      expect(f.size).toBeGreaterThan(0);
    }
    expect(res.body.items.map((f) => (f.kind === "file" ? f.type : f.kind))).toEqual(["pptx", "jpg", "jpg", "link"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    socket.close();
  });

  it("a live screen needs no sign-in in mock mode: the demo account is the user", async () => {
    const { socket, pid } = await paired("live");
    const res = await api.get<Files>("/api/files", pid);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(DEMO_IDS.length);
    socket.close();
  });

  it("SRC-02 listing tells the screen object which ids were shown, so the screen moves to choosing", async () => {
    const { socket, pid } = await paired("live");
    await api.get("/api/files", pid);
    await socket.stateWhere((v) => v.state === "choosing");
    socket.close();
  });

  it("refuses a missing or malformed credential and a wrong method", async () => {
    expect((await api.get("/api/files")).body).toEqual(problem("unauthorized"));
    expect((await api.get("/api/files", "not.a.credential")).body).toEqual(problem("unauthorized"));
    const post = await api.post("/api/files", {});
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET");
  });
});

describe("POST /api/approve resolves the file on the server", () => {
  it("SRC-01 approve: the id picks a listed file and the screen sees the server's name, not one from the client", async () => {
    const { screen, socket, pid } = await paired("live");
    await api.get("/api/files", pid);
    const approved = await api.post<{ state: string }>("/api/approve", { ids: [DEMO_ITEMS.deck.id] }, { auth: pid });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: "approved", items: [{ name: DEMO_ITEMS.deck.name }] });
    const onScreen = await socket.stateWhere((v) => v.state === "approved");
    expect((onScreen.view as { items: { name: string }[] }).items).toEqual([
      { kind: "file", ...slotted(DEMO_ITEMS.deck), type: "pptx", size: expect.any(Number) },
    ]);
    expect(screen.sid).toBeTruthy();
    socket.close();
  });

  it("SRC-02 file: an id that is not in the list is refused in demo and live, whatever it looks like", async () => {
    for (const mode of ["demo", "live"] as const) {
      const { socket, pid } = await paired(mode);
      await api.get("/api/files", pid);
      for (const fileId of [
        "not-listed",
        "../../etc/passwd",
        `${DEMO_ITEMS.deck.id}/../x`,
        "constructor",
        "__proto__",
        "https://evil.example/a.pptx",
      ]) {
        const res = await api.post("/api/approve", { ids: [fileId] }, { auth: pid });
        expect(res.status, `${mode} ${fileId}`).toBe(404);
        expect(res.body).toEqual(problem("file_not_found"));
      }
      socket.close();
    }
  });

  it("SRC-01 approve: the body carries an id and nothing else; a client-supplied name, url or ref is refused", async () => {
    const { socket, pid } = await paired("demo");
    await api.get("/api/files", pid);
    for (const extra of [
      { name: "Evil.pptx" },
      { url: "https://evil.example/a.pptx" },
      { ref: "x", source: "graph" },
    ]) {
      const res = await api.post("/api/approve", { ids: [DEMO_ITEMS.deck.id], ...extra }, { auth: pid });
      expect(res.body).toEqual(problem("bad_request"));
    }
    socket.close();
  });

  it("SRC-02 file: live approve of a listed file that this screen was never shown is refused by the screen", async () => {
    const { socket, pid } = await paired("live");
    // No GET /api/files first, so the screen object holds no listed ids.
    const res = await api.post("/api/approve", { ids: [DEMO_ITEMS.deck.id] }, { auth: pid });
    expect(res.body).toEqual(problem("file_not_found"));
    socket.close();
  });

  it("approve with valid ids works once and a repeat of the same set is idempotent; another set is wrong_state", async () => {
    const { socket, pid } = await paired("demo");
    await api.get("/api/files", pid);
    expect((await api.post("/api/approve", { ids: [DEMO_ITEMS.deck.id] }, { auth: pid })).status).toBe(200);
    expect((await api.post("/api/approve", { ids: [DEMO_ITEMS.deck.id] }, { auth: pid })).status).toBe(200);
    expect((await api.post("/api/approve", { ids: [DEMO_ITEMS.horizontal.id] }, { auth: pid })).body).toEqual(
      problem("wrong_state"),
    );
    socket.close();
  });

  it("a live session takes exactly one file: a list or a link is refused, one file approves", async () => {
    const { socket, pid } = await paired("live");
    await api.get("/api/files", pid);
    for (const ids of [DEMO_IDS, [DEMO_ITEMS.link.id]]) {
      const res = await api.post("/api/approve", { ids }, { auth: pid });
      expect(res.body, JSON.stringify(ids)).toEqual(problem("bad_request"));
    }
    // Two ids the source never listed: refused for the count, before a listing could refuse them as unknown.
    expect((await api.post("/api/approve", { ids: ["nope-1", "nope-2"] }, { auth: pid })).body).toEqual(
      problem("bad_request"),
    );
    expect((await api.post("/api/approve", { ids: ["nope-1"] }, { auth: pid })).body).not.toEqual(
      problem("bad_request"),
    );
    expect((await api.post("/api/approve", { ids: [DEMO_ITEMS.deck.id] }, { auth: pid })).status).toBe(200);
    socket.close();
  });

  it("approves the whole demo catalog as one list: files by name, then the link, on both views", async () => {
    const { socket, pid } = await paired("demo");
    await api.get("/api/files", pid);
    const approved = await api.post<{ items: unknown[] }>("/api/approve", { ids: DEMO_IDS }, { auth: pid });
    expect(approved.status).toBe(200);
    const want = [
      { kind: "file", ...slotted(DEMO_ITEMS.deck), type: "pptx", size: expect.any(Number) },
      { kind: "file", ...slotted(DEMO_ITEMS.horizontal), type: "jpg", size: expect.any(Number) },
      { kind: "file", ...slotted(DEMO_ITEMS.vertical), type: "jpg", size: expect.any(Number) },
      { kind: "link", id: DEMO_ITEMS.link.slot, url: "https://www.vevox.com/", title: DEMO_ITEMS.link.name },
    ];
    expect(approved.body.items).toEqual(want);
    const onScreen = await socket.stateWhere((v) => v.state === "approved");
    expect((onScreen.view as { items: unknown[] }).items).toEqual(want);
    socket.close();
  });

  it("refuses an empty list, a repeated id and more than 12 ids before the source is read", async () => {
    const { socket, pid } = await paired("demo");
    await api.get("/api/files", pid);
    for (const ids of [
      [],
      [DEMO_ITEMS.deck.id, DEMO_ITEMS.deck.id],
      Array.from({ length: 13 }, (_, i) => `x${i}`),
      DEMO_ITEMS.deck.id,
    ]) {
      const res = await api.post("/api/approve", { ids }, { auth: pid });
      expect(res.body, JSON.stringify(ids)).toEqual(problem("bad_request"));
    }
    expect((await api.post("/api/approve", { fileId: DEMO_ITEMS.deck.id }, { auth: pid })).body).toEqual(
      problem("bad_request"),
    );
    socket.close();
  });
});

describe("OAuth and account routes while Entra is not configured", () => {
  it("AUTH-03 state: /auth/start and /auth/callback answer source_unavailable and set no cookie", async () => {
    for (const path of ["/auth/start", "/auth/callback?code=x&state=y"]) {
      const res = await fetch(`${wrangler.url}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(502);
      expect(await res.json()).toEqual({ type: "about:blank", status: 502, code: "source_unavailable" });
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("AUTH-03 state: the OAuth routes are GET only", async () => {
    const res = await api.post("/auth/start", {});
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("/api/me says the demo account is signed in, sign-out needs a session and disconnect is unavailable", async () => {
    expect((await api.get("/api/me")).body).toEqual({
      source: "mock",
      signedIn: true,
      email: null,
      launchMode: "preview",
    });
    // Sign-out serves email members too, so it no longer depends on the Graph source.
    expect((await api.post("/api/me/signout", {})).body).toEqual(problem("auth_required"));
    expect((await api.post("/api/me/disconnect", {})).body).toEqual(problem("source_unavailable"));
  });
});
