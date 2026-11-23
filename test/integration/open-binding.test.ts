// OPEN-02 binding: with LINK_BINDING_DEFAULT=enforce a fetch from another address than the screen's is refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveDemo, fetchLink, problemOf } from "./open-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  wrangler = await startPairing({ LINK_BINDING_DEFAULT: "enforce" });
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
});
