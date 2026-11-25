// A thin Worker around the SpendGuard for test/integration/spend-guard.test.ts: POST /rpc/<method> forwards the JSON
// argument array to the stub; /client/take goes through the fail-closed client; /breaker runs the breaker over the
// real Durable Object with an in-memory switch store. Not typechecked (test/fixtures is excluded).
import { runBreaker } from "../../../src/worker/spend/breaker.ts";
import { SpendGuard, spendFor, spendStub } from "../../../src/worker/spend/guard.ts";

export { SpendGuard };

const rows = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return new Response("ok");
    if (url.pathname.startsWith("/rpc/")) {
      const args = await request.json();
      const out = await spendStub(env)[url.pathname.slice(5)](...args);
      return Response.json(out ?? null);
    }
    if (url.pathname === "/client/take") {
      const { meter, n, scope } = await request.json();
      return Response.json(await spendFor(env).take(meter, n, scope));
    }
    if (url.pathname === "/breaker") {
      const store = {
        get: async (name) => rows.get(name),
        set: async (name, value) => void rows.set(name, value),
      };
      const report = await runBreaker({
        guard: spendStub(env),
        store,
        vars: env,
        now: Date.now,
        adminUrl: `${env.PUBLIC_ORIGIN}/admin`,
        notify: async (alert) => console.log(JSON.stringify({ evt: "breaker", ...alert })),
      });
      return Response.json({ report, rows: Object.fromEntries(rows) });
    }
    return new Response("not found", { status: 404 });
  },
};
