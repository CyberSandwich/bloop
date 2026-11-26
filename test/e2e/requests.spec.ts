// The request budget (docs/design.md section 11, tools/requests.json): how many requests reach the Worker while a
// task page loads, and whether the module graph arrives in one wave. Runs in CI only, like every Playwright test.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { parseJsonc } from "../../tools/jsonc.mjs";

const budgets: Record<string, { worker: number; lateModules: number }> = JSON.parse(
  readFileSync("tools/requests.json", "utf8"),
);

/** The paths the asset layer answers without the Worker: the negated entries of wrangler.jsonc `run_worker_first`. */
const staticPaths = (() => {
  const list: string[] = parseJsonc(readFileSync("wrangler.jsonc", "utf8")).assets.run_worker_first;
  return list.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
})();
const reachesWorker = (pathname: string) =>
  !staticPaths.some((p) => (p.endsWith("/*") ? pathname.startsWith(p.slice(0, -1)) : pathname === p));

for (const [path, budget] of Object.entries(budgets)) {
  test(`request budget: ${path} reaches the Worker at most ${budget.worker} times, with ${budget.lateModules} late modules`, async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const scripts = new Map<string, { path: string; start: number; end?: number }>();
    cdp.on("Network.requestWillBeSent", (e) => {
      if (e.type === "Script") scripts.set(e.requestId, { path: new URL(e.request.url).pathname, start: e.timestamp });
    });
    cdp.on("Network.responseReceived", (e) => {
      const script = scripts.get(e.requestId);
      if (script) script.end = e.timestamp;
    });

    const worker: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === new URL(page.url() === "about:blank" ? "http://localhost:8787" : page.url()).origin) {
        if (reachesWorker(url.pathname)) worker.push(`${request.method()} ${url.pathname}`);
      }
    });

    await page.goto(path);
    await page.waitForLoadState("networkidle");

    expect(worker.length, worker.join(", ")).toBeLessThanOrEqual(budget.worker);
    const ends = [...scripts.values()].flatMap((s) => (s.end === undefined ? [] : [s.end]));
    const firstEnd = Math.min(...ends);
    // Only the page's static graph is one wave; a lazy import() starts when its feature does.
    const graph = new Set(
      await page.$$eval('link[rel="modulepreload"], script[type="module"][src]', (nodes) =>
        nodes.map((n) => n.getAttribute("src") ?? n.getAttribute("href") ?? ""),
      ),
    );
    const late = [...scripts.values()].filter((s) => graph.has(s.path) && s.start > firstEnd);
    expect(late.length, "module requests that started after the first module response").toBeLessThanOrEqual(
      budget.lateModules,
    );
  });
}
