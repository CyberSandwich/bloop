import { describe, expect, it } from "vitest";
import { PROD_VARS } from "../env-vars.ts";

const ORIGIN = "http://127.0.0.1:8787";
const REF = "S".repeat(22);

interface UpgradeRoute {
  pattern: URLPattern;
  handler: (r: Request, env: object, m: URLPatternResult) => Promise<Response>;
}

/** A Worker env whose rate limit and Screen object record the order they are called in. */
function env(allow: boolean) {
  const calls: string[] = [];
  const RL_CONTROL = {
    limit: async () => {
      calls.push("limit");
      return { success: allow };
    },
  };
  const stub = {
    fetch: async () => {
      calls.push("screen");
      return new Response(null, { status: 200 });
    },
  };
  return {
    calls,
    env: { ...PROD_VARS, PUBLIC_ORIGIN: ORIGIN, RL_CONTROL, SCREEN: { idFromName: (n: string) => n, get: () => stub } },
  };
}

async function upgrade(e: object, path: "/api/screen/ws" | "/api/pair/ws") {
  // A non-literal specifier: the route's type graph needs the Workers types, which the test tsconfig leaves out.
  const module = "../../src/worker/routes/pairing.ts";
  const { pairingRoutes } = (await import(module)) as { pairingRoutes: readonly UpgradeRoute[] };
  const request = new Request(`${ORIGIN}${path}?ref=${REF}`, { headers: { Origin: ORIGIN, Upgrade: "websocket" } });
  const route = pairingRoutes.find((r) => r.pattern.test(request.url)) as UpgradeRoute;
  return route.handler(request, e, route.pattern.exec(request.url) as URLPatternResult);
}

describe("PAIR-10 upgrade rate limit: RL_CONTROL per address before the Screen object", () => {
  for (const path of ["/api/screen/ws", "/api/pair/ws"] as const) {
    it(`PAIR-10 upgrade rate limit ${path}: a spent budget answers 429 and reaches no Screen object`, async () => {
      const spent = env(false);
      expect((await upgrade(spent.env, path)).status).toBe(429);
      expect(spent.calls).toEqual(["limit"]);
      const open = env(true);
      expect((await upgrade(open.env, path)).status).toBe(200);
      expect(open.calls).toEqual(["limit", "screen"]);
    });
  }

  it("PAIR-13 rate limit binding required: a missing binding is logged once per name, with the name", async () => {
    const { RL_CONTROL: _, ...without } = env(true).env;
    const errors: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      for (let i = 0; i < 3; i++) expect((await upgrade(without, "/api/screen/ws")).status).toBe(500);
    } finally {
      console.error = log;
    }
    expect(errors.filter((line) => line.includes("RL_CONTROL")).length).toBeLessThanOrEqual(1);
    expect(errors.some((line) => line.includes("rate-limit binding missing: RL_CONTROL"))).toBe(true);
  });
});
