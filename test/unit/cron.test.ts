import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ALLOTMENT, CRON, type CronJob, runCron } from "../../src/worker/cron.ts";

type Job = CronJob<object, object>;

describe("cron: the job lists", () => {
  it("wrangler.jsonc has exactly the triggers the dispatcher names", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const crons = (text.match(/"crons":\s*\[([^\]]*)\]/)?.[1] ?? "").match(/"[^"]+"/g)?.map((c) => c.slice(1, -1));
    expect([...(crons ?? [])].sort()).toEqual(Object.values(CRON).sort());
  });

  it("an unknown trigger runs nothing", async () => {
    await expect(runCron("1 2 3 4 5", {}, {}, {})).resolves.toBeUndefined();
  });
});

describe("cron: the dispatcher", () => {
  it("gives each job the allotment, runs them in order and logs a job with work left", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: [string, number][] = [];
    const job = (name: string, more: boolean): Job => ({
      name,
      run: async (_e, _c, allotment) => {
        seen.push([name, allotment]);
        return { more };
      },
    });
    await runCron("t", {}, {}, { t: [job("a", false), job("b", true)] });
    expect(seen).toEqual([
      ["a", ALLOTMENT],
      ["b", ALLOTMENT],
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('{"evt":"cron_more","job":"b"}');
    log.mockRestore();
  });

  it("a failing job is logged and does not stop the jobs after it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let ran = false;
    const jobs: Job[] = [
      {
        name: "bad",
        run: async () => {
          throw new Error("boom");
        },
      },
      {
        name: "good",
        run: async () => {
          ran = true;
          return { more: false };
        },
      },
    ];
    await runCron("t", {}, {}, { t: jobs });
    expect(ran).toBe(true);
    expect(error).toHaveBeenCalledWith('{"evt":"cron_job_failed","job":"bad"}');
    error.mockRestore();
  });
});
