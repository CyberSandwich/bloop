// OPEN-02 binding: with LINK_BINDING_DEFAULT=enforce a fetch from another address than the screen's is refused.
// Migrated: the view-link case stores a guest drop.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SILENCE_MS } from "../../src/worker/config.ts";
import { validVideo } from "../zip-builder.ts";
import { openGuestView } from "./drop-client.ts";
import { approveDemo, fetchLink, problemOf, sleep } from "./open-client.ts";
import { Api, claim, Socket, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

/** The frame the runtime answers itself, which keeps a socket live (screen.ts setWebSocketAutoResponse). */
const PING = '{"v":1,"t":"ping"}';

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing({ LINK_BINDING_DEFAULT: "enforce" }, { migrate: true });
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

describe("OPEN-02 binding", () => {
  it("enforce: a fetch from the screen's address works, another address gets 403 link_binding_failed and costs no fetch", async () => {
    const { socket, url } = await approveDemo(api);
    const other = await fetchLink(url, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(other.status).toBe(403);
    expect((await problemOf(other)).code).toBe("link_binding_failed");
    expect((await fetchLink(url)).status).toBe(200);
    socket.close();
  });

  it("OPEN-02 binding: unauthenticated socket leaves binding as it was", async () => {
    const { screen, socket, url } = await approveDemo(api);
    // The ref is the first 22 characters of any leaked token: anyone can open a socket on it, from anywhere.
    const bare = await Socket.open(api.base, `/api/screen/ws?ref=${screen.ref}`, api.base, {
      "CF-Connecting-IP": "203.0.113.9",
    });
    const other = await fetchLink(url, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(other.status).toBe(403);
    expect((await fetchLink(url)).status).toBe(200);
    bare.close();
    socket.close();
  });

  it("OPEN-02 binding: a screen that only polls still binds its links to its address", async () => {
    const created = await api.post<{ sid: string }>("/api/screens", { mode: "demo" });
    const { sid } = created.body;
    const state = await api.get<{ code: { code: string } }>("/api/screen/state", sid);
    const claimed = await claim(api, state.body.code.code);
    await api.get("/api/files", claimed.body.pid);
    expect((await api.post("/api/approve", { ids: ["demo-deck"] }, { auth: claimed.body.pid })).status).toBe(200);
    const minted = await api.post<{ links: Record<string, string | null> }>(
      "/api/screen/link",
      { purpose: "protocol" },
      { auth: sid },
    );
    expect(minted.status).toBe(200);
    const url = (minted.body.links.protocol ?? minted.body.links.pdf ?? "").replace("ms-powerpoint:ofv|u|", "");
    const other = await fetchLink(url, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(other.status).toBe(403);
    expect((await fetchLink(url)).status).toBe(200);
  });

  it("OPEN-02 binding: a poll from another address cannot rebind past a live authed screen socket", async () => {
    const { screen, socket, url } = await approveDemo(api);
    // Live by its answered ping, not by finishing inside TEST_SILENCE_MS.
    socket.send(PING);
    const polled = await api.call("GET", "/api/screen/state", undefined, {
      auth: screen.sid,
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    expect(polled.status).toBe(200);
    expect((await fetchLink(url, { headers: { "CF-Connecting-IP": "203.0.113.9" } })).status).toBe(403);
    expect((await fetchLink(url)).status).toBe(200);
    socket.close();
  });

  it("OPEN-02 binding: a hello from another address cannot rebind past a live lectern", async () => {
    const { screen, socket, url } = await approveDemo(api);
    socket.send(PING);
    const other = { "CF-Connecting-IP": "203.0.113.9" };
    const intruder = await Socket.open(api.base, `/api/screen/ws?ref=${screen.ref}`, api.base, other);
    intruder.send({ t: "hello", sid: screen.sid });
    await intruder.stateWhere(() => true);
    expect((await fetchLink(url, { headers: other })).status).toBe(403);
    expect((await fetchLink(url)).status).toBe(200);
    intruder.close();
    socket.close();
  });

  it("OPEN-02 binding handover: the lectern gone quiet hands the binding to the newer live screen, which keeps it after closing", async () => {
    const { screen, socket, url } = await approveDemo(api);
    const moved = { "CF-Connecting-IP": "203.0.113.20" };
    const b = await Socket.open(api.base, `/api/screen/ws?ref=${screen.ref}`, api.base, moved);
    b.send({ t: "hello", sid: screen.sid });
    await b.stateWhere(() => true);
    expect((await fetchLink(url, { headers: moved })).status).toBe(403);
    // The lectern says nothing past the silence window (TEST_TIMING shortens it); B answers the runtime's ping.
    const until = Date.now() + TEST_SILENCE_MS + 500;
    while (Date.now() < until) {
      b.send(PING);
      await sleep(500);
    }
    expect((await fetchLink(url, { headers: moved })).status).toBe(200);
    expect((await fetchLink(url)).status).toBe(403);
    b.close();
    await sleep(300);
    expect((await fetchLink(url, { headers: moved })).status).toBe(200);
    socket.close();
  });

  it("OPEN-02 audit: a refused link of an ended session is audited against the session that minted it", async () => {
    const rows = (where: string) =>
      Number(wrangler.d1(`SELECT count(*) AS n FROM audit_event WHERE type = 'link.refused' AND ${where}`)[0]?.n ?? 0);
    const { screen, socket, url } = await approveDemo(api);
    const minted = wrangler.d1(
      "SELECT session_id FROM audit_event WHERE type = 'link.minted' ORDER BY at DESC LIMIT 1",
    );
    const first = String(minted[0]?.session_id);
    expect((await api.post("/api/screen/end", {}, { auth: screen.sid })).status).toBe(200);
    const othersBefore = rows(`session_id != '${first}'`);
    expect((await fetchLink(url)).status).toBeGreaterThanOrEqual(400);
    expect(rows(`session_id = '${first}'`)).toBe(1);
    expect(rows(`session_id != '${first}'`)).toBe(othersBefore);
    socket.close();
  });

  it("REL-16 fetch_refused: a refused /f/ request of the live session is audited and counted with its cause, and starts nothing", async () => {
    const { screen, socket, url } = await approveDemo(api);
    const session = String(
      wrangler.d1("SELECT session_id FROM audit_event WHERE type = 'link.minted' ORDER BY at DESC LIMIT 1")[0]
        ?.session_id,
    );
    const failures = () =>
      Number(
        wrangler.d1(
          "SELECT count(*) AS n FROM metric_event WHERE name = 'failure' AND cause = 'link_binding_failed'",
        )[0]?.n ?? 0,
      );
    const before = failures();
    const stateOf = async () => (await api.get<{ state: string }>("/api/screen/state", screen.sid)).body.state;
    expect(await stateOf()).toBe("approved");

    const res = await fetchLink(url, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(res.status).toBe(403);
    const refused = wrangler.d1(
      `SELECT detail FROM audit_event WHERE type = 'link.refused' AND session_id = '${session}'`,
    );
    expect(refused).toHaveLength(1);
    expect(JSON.parse(String(refused[0]?.detail))).toMatchObject({ cause: "link_binding_failed" });
    expect(failures()).toBe(before + 1);
    expect(await stateOf()).toBe("approved");
    expect(wrangler.d1(`SELECT first_open_at FROM session WHERE id = '${session}'`)[0]?.first_open_at).toBeNull();
    socket.close();
  });

  it("VID-02 a refused view link writes one audit row, however often its player retries", async () => {
    const refusedRows = () =>
      Number(wrangler.d1("SELECT count(*) AS n FROM audit_event WHERE type = 'link.refused'")[0]?.n ?? 0);
    const { socket, url } = await openGuestView(api, validVideo("isom", 3000), "Clip.mp4", "video/mp4");
    const before = refusedRows();
    for (let i = 0; i < 4; i++) {
      const res = await fetchLink(url, { headers: { Range: "bytes=0-9", "CF-Connecting-IP": "203.0.113.9" } });
      expect(res.status).toBe(403);
    }
    expect(refusedRows()).toBe(before + 1);
    expect((await fetchLink(url, { headers: { Range: "bytes=0-9" } })).status).toBe(206);
    socket.close();
  });
});
