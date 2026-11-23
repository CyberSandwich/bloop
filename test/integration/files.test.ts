// /api/files and approve against the default mock source, and the OAuth routes while Entra is not configured.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
interface Files {
  files: { id: string; name: string; type: string; modifiedAt: number; size: number | null }[];
}

/** A paired owner phone on a screen of the given mode. */
async function paired(mode: "demo" | "live") {
  const { screen, socket, code } = await openScreen(api, mode);
  const claimed = await claim(api, code);
  return { screen, socket, pid: claimed.body.pid };
}

describe("GET /api/files with the mock source", () => {
  it("SRC-04 isolation: a demo screen lists the demo account's decks, newest first, in the documented shape", async () => {
    const { socket, pid } = await paired("demo");
    const res = await api.get<Files>("/api/files", pid);
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.id)).toEqual(["demo-deck", "demo-review", "demo-pdf"]);
    for (const f of res.body.files) {
      expect(Object.keys(f).sort()).toEqual(["id", "modifiedAt", "name", "size", "type"]);
      expect(f.modifiedAt).toBeLessThanOrEqual(Date.now());
      expect(f.size).toBeGreaterThan(0);
      expect(f.size).toBeLessThan(50_000);
    }
    expect(res.body.files.map((f) => f.type)).toEqual(["pptx", "pptx", "pdf"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    socket.close();
  });

  it("a live screen needs no sign-in in mock mode: the demo account is the user", async () => {
    const { socket, pid } = await paired("live");
    const res = await api.get<Files>("/api/files", pid);
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(3);
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
    const approved = await api.post<{ state: string; fileName: string }>(
      "/api/approve",
      { fileId: "demo-review" },
      { auth: pid },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: "approved", fileName: "Quarterly review.pptx" });
    const onScreen = await socket.stateWhere((v) => v.state === "approved");
    expect((onScreen.view as { fileName: string }).fileName).toBe("Quarterly review.pptx");
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
        "demo-deck/../x",
        "constructor",
        "__proto__",
        "https://evil.example/a.pptx",
      ]) {
        const res = await api.post("/api/approve", { fileId }, { auth: pid });
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
      const res = await api.post("/api/approve", { fileId: "demo-deck", ...extra }, { auth: pid });
      expect(res.body).toEqual(problem("bad_request"));
    }
    socket.close();
  });

  it("SRC-02 file: live approve of a listed file that this screen was never shown is refused by the screen", async () => {
    const { socket, pid } = await paired("live");
    // No GET /api/files first, so the screen object holds no listed ids.
    const res = await api.post("/api/approve", { fileId: "demo-deck" }, { auth: pid });
    expect(res.body).toEqual(problem("file_not_found"));
    socket.close();
  });

  it("approve with a valid id works once and a repeat of the same id is idempotent", async () => {
    const { socket, pid } = await paired("demo");
    await api.get("/api/files", pid);
    expect((await api.post("/api/approve", { fileId: "demo-deck" }, { auth: pid })).status).toBe(200);
    expect((await api.post("/api/approve", { fileId: "demo-deck" }, { auth: pid })).status).toBe(200);
    expect((await api.post("/api/approve", { fileId: "demo-pdf" }, { auth: pid })).status).toBe(409);
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

  it("/api/me says the demo account is signed in, and sign-out and disconnect are unavailable", async () => {
    expect((await api.get("/api/me")).body).toEqual({ source: "mock", signedIn: true, email: null });
    expect((await api.post("/api/me/signout", {})).body).toEqual(problem("source_unavailable"));
    expect((await api.post("/api/me/disconnect", {})).body).toEqual(problem("source_unavailable"));
  });
});
