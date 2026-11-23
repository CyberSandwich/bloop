// Link lifetimes with short windows, in stream mode so the same run checks that mode too.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveDemo, fetchLink, problemOf, sleep } from "./open-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing({
    OPEN_PATH_MODE: "stream",
    LINK_FIRST_FETCH_SECONDS: "3",
    LINK_FETCH_WINDOW_SECONDS: "2",
  });
  api = new Api(wrangler.url);
});
afterAll(() => wrangler?.stop());

describe("OPEN-01 link-life with short windows", () => {
  it("a link that is never fetched dies at the first-fetch deadline", async () => {
    const { socket, url } = await approveDemo(api);
    await sleep(3300);
    const res = await fetchLink(url);
    expect(res.status).toBe(410);
    expect((await problemOf(res)).code).toBe("link_expired");
    socket.close();
  });

  it("after the first fetch the link works inside the window and dies after it, even with fetches left", async () => {
    const { socket, url } = await approveDemo(api);
    expect((await fetchLink(url)).status).toBe(200);
    await sleep(500);
    expect((await fetchLink(url)).status).toBe(200);
    await sleep(2200);
    const res = await fetchLink(url);
    expect(res.status).toBe(410);
    expect((await problemOf(res)).code).toBe("link_expired");
    socket.close();
  });

  it("an expired link does not end the session: a fresh download link still works", async () => {
    const { socket, screen, url } = await approveDemo(api);
    socket.send({ t: "launched", mode: "protocol" });
    await socket.stateWhere((v) => v.state === "opening");
    await sleep(3300);
    expect((await fetchLink(url)).status).toBe(410);
    const fresh = await api.post<{ links: { download: string } }>(
      "/api/screen/link",
      { purpose: "download" },
      { auth: screen.sid },
    );
    expect((await fetchLink(fresh.body.links.download)).status).toBe(200);
    socket.close();
  });
});

describe("stream mode", () => {
  it("serves the bytes through the Worker with the documented headers", async () => {
    const { socket, url } = await approveDemo(api);
    const res = await fetchLink(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get("Content-Length"))).toBe(bytes.length);
    socket.close();
  });
});
