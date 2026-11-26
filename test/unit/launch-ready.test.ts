// launchReady (src/worker/pages.ts): the Worker's one reader of the build's /_launch.json, which the public never gets.
import { describe, expect, it } from "vitest";
import { launchReady, type PageEnv, servePage } from "../../src/worker/pages.ts";
import { PROD_VARS } from "../env-vars.ts";
import { testDb } from "./d1-shim.ts";

const ORIGIN = "http://localhost:8787";
const asked = new Request(`${ORIGIN}/admin/mode`, { method: "POST" });

/** An asset layer holding `/_launch.json` as given (a Response, or a thrown error), 404 for the rest. */
const assets = (manifest: () => Response) => ({
  fetch: async (req: Request) =>
    new URL(req.url).pathname === "/_launch.json" ? manifest() : new Response("not found", { status: 404 }),
});
const envWith = (manifest: () => Response) => ({ ASSETS: assets(manifest) }) as unknown as Pick<PageEnv, "ASSETS">;
const json =
  (value: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(value), { status });

describe("launchReady reads the manifest through the asset binding and fails closed", () => {
  it("true only for launchReady: true", async () => {
    expect(await launchReady(envWith(json({ launchReady: true, placeholder: [] })), asked)).toBe(true);
  });

  it.each([
    ["false in the file", json({ launchReady: false, placeholder: ["content/open/privacy.md"] })],
    ["a missing file", () => new Response("not found", { status: 404 })],
    ["a non-200", json({ launchReady: true }, 500)],
    ["bad JSON", () => new Response("{nope")],
    ["a non-boolean", json({ launchReady: "true" })],
    ["a missing key", json({ placeholder: [] })],
    ["a JSON null", () => new Response("null")],
    [
      "a binding that throws",
      () => {
        throw new Error("binding down");
      },
    ],
  ])("is false for %s", async (_name, manifest) => {
    expect(await launchReady(envWith(manifest), asked)).toBe(false);
  });

  it("the manifest is readable through the binding while the public request for it is 404, in both modes", async () => {
    for (const mode of ["preview", "open"]) {
      const db = testDb();
      db.raw
        .prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)")
        .run("launch_mode", mode, 1);
      const env = {
        ...PROD_VARS,
        PUBLIC_ORIGIN: ORIGIN,
        TEST_TIMING: "1",
        DB: db,
        ASSETS: assets(json({ launchReady: true, placeholder: [] })),
      } as unknown as PageEnv;
      expect(await launchReady(env, asked), mode).toBe(true);
      expect((await servePage(new Request(`${ORIGIN}/_launch.json`), env)).status, mode).toBe(404);
    }
  });
});
