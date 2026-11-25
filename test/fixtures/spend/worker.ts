// A thin Worker around the SpendGuard for test/integration/spend-guard.test.ts: POST /rpc/<method> forwards the JSON
// argument array to the stub (/rpc/public/<method> to the public instance); /client/take goes through the
// fail-closed client; /breaker runs the breaker over the real Durable Object with an in-memory switch store.
// Test-only and unauthenticated: it answers loopback hosts only, and its config is never deployed.
// Not typechecked (test/fixtures is excluded).
import { runBreaker } from "../../../src/worker/spend/breaker.ts";
import { SpendGuard, spendFor, spendStub } from "../../../src/worker/spend/guard.ts";

export { SpendGuard };

const rows = new Map();
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!LOOPBACK.has(url.hostname)) return new Response("loopback only", { status: 403 });
    if (url.pathname === "/api/health") return new Response("ok");
    if (url.pathname.startsWith("/rpc/")) {
      const args = await request.json();
      const [instance, method] = url.pathname.startsWith("/rpc/public/")
        ? ["public", url.pathname.slice(12)]
        : ["global", url.pathname.slice(5)];
      const out = await spendStub(env, instance)[method](...args);
      return Response.json(out ?? null);
    }
    if (url.pathname === "/client/take") {
      const { meter, n, scope } = await request.json();
      // `?down=1`: a namespace that cannot be reached, as when the binding is gone.
      const spend = spendFor(url.searchParams.has("down") ? { ...env, SPEND_GUARD: undefined } : env, () => ({}));
      return Response.json(await spend.take(meter, n, scope));
    }
    if (url.pathname === "/breaker") {
      const store = {
        get: async (name) => rows.get(name),
        row: async (name) => (rows.has(name) ? { value: rows.get(name), by: "breaker" } : undefined),
        set: async (name, value) => void rows.set(name, value),
      };
      const report = await runBreaker({
        guard: spendStub(env),
        publicGuard: spendStub(env, "public"),
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
