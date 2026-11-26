// The dev mailbox route against wrangler dev: on with DEV_MAILBOX=1 (the harness default), not_found without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

let on: Wrangler;
let off: Wrangler;
beforeAll(async () => {
  [on, off] = await Promise.all([startPairing(), startPairing({ DEV_MAILBOX: "0" })]);
});
afterAll(() => Promise.all([on?.stop(), off?.stop()]));

const mailbox = (w: Wrangler, init?: RequestInit, query = "") => fetch(`${w.url}/api/dev/mailbox${query}`, init);

describe("dev mailbox", () => {
  it("dev mailbox: lists the kept mail as JSON, filtered by ?to=", async () => {
    const res = await mailbox(on, undefined, "?to=someone@example.test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  it("dev mailbox: DELETE clears it, and needs our Origin", async () => {
    expect((await mailbox(on, { method: "DELETE" })).status).toBe(403);
    expect((await mailbox(on, { method: "DELETE", headers: { Origin: on.url } })).status).toBe(204);
  });

  it("dev mailbox: without DEV_MAILBOX both methods are not_found", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await mailbox(off, { method, headers: { Origin: off.url } });
      expect(res.status, method).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    }
  });
});
