import { describe, expect, it } from "vitest";
import { PROD_VARS } from "../env-vars.ts";

const ORIGIN = "http://127.0.0.1:8787";
const REF = "S".repeat(22);

interface UpgradeRoute {
  pattern: URLPattern;
  handler: (r: Request, env: object, m: URLPatternResult) => Promise<Response>;
}

/** A Worker env whose rate limits and Screen object record the order they are called in. */
function env(allow: boolean) {
  const calls: string[] = [];
  const keys: string[] = [];
  const RL_UPGRADE = {
    limit: async ({ key }: { key: string }) => {
      calls.push("limit");
      keys.push(key);
      return { success: allow };
    },
  };
  // A tap's budget: an upgrade must never spend it.
  const RL_CONTROL = {
    limit: async () => {
      calls.push("control");
      return { success: true };
    },
  };
  const stub = {
    fetch: async () => {
      calls.push("screen");
      return new Response(null, { status: 200 });
    },
  };
  const SCREEN = { idFromName: (n: string) => n, get: () => stub };
  return { calls, keys, env: { ...PROD_VARS, PUBLIC_ORIGIN: ORIGIN, RL_UPGRADE, RL_CONTROL, SCREEN } };
}

async function upgrade(e: object, path: "/api/screen/ws" | "/api/pair/ws", ip?: string) {
  // A non-literal specifier: the route's type graph needs the Workers types, which the test tsconfig leaves out.
  const module = "../../src/worker/routes/pairing.ts";
  const { pairingRoutes } = (await import(module)) as { pairingRoutes: readonly UpgradeRoute[] };
  const request = new Request(`${ORIGIN}${path}?ref=${REF}`, {
    headers: { Origin: ORIGIN, Upgrade: "websocket", ...(ip ? { "CF-Connecting-IP": ip } : {}) },
  });
  const route = pairingRoutes.find((r) => r.pattern.test(request.url)) as UpgradeRoute;
  return route.handler(request, e, route.pattern.exec(request.url) as URLPatternResult);
}

describe("PAIR-10 upgrade rate limit: RL_UPGRADE per screen and address before the Screen object", () => {
  for (const path of ["/api/screen/ws", "/api/pair/ws"] as const) {
    it(`PAIR-10 upgrade rate limit ${path}: a spent budget answers 429 and reaches no Screen object`, async () => {
      const spent = env(false);
      expect((await upgrade(spent.env, path)).status).toBe(429);
      expect(spent.calls).toEqual(["limit"]);
      const open = env(true);
      expect((await upgrade(open.env, path)).status).toBe(200);
      expect(open.calls).toEqual(["limit", "screen"]);
      expect(open.keys[0]?.startsWith(`${REF}.`)).toBe(true);
    });
  }

  it("PAIR-10 upgrade rate limit: one IPv6 /64 is one budget, so rotating addresses inside it gains nothing", async () => {
    const one = env(true);
    await upgrade(one.env, "/api/screen/ws", "2001:db8:1:2::1");
    await upgrade(one.env, "/api/screen/ws", "2001:db8:1:2:ffff::9");
    await upgrade(one.env, "/api/screen/ws", "2001:db8:1:3::1");
    expect(one.keys[0]).toBe(one.keys[1]);
    expect(one.keys[2]).not.toBe(one.keys[0]);
  });

  it("PAIR-13 rate limit binding required: a missing binding is logged once per name, with the name", async () => {
    const { RL_UPGRADE: _, ...without } = env(true).env;
    const errors: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      for (let i = 0; i < 3; i++) expect((await upgrade(without, "/api/screen/ws")).status).toBe(500);
    } finally {
      console.error = log;
    }
    expect(errors.filter((line) => line.includes("RL_UPGRADE"))).toEqual(["rate-limit binding missing: RL_UPGRADE"]);
  });
});
