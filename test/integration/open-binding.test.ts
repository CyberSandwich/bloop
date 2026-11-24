// OPEN-02 binding: with LINK_BINDING_DEFAULT=enforce a fetch from another address than the screen's is refused.
// Migrated: the view-link case stores a guest drop.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validVideo } from "../zip-builder.ts";
import { openGuestView } from "./drop-client.ts";
import { approveDemo, fetchLink, problemOf } from "./open-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

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
