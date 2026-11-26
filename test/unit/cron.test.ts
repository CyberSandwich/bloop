import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ALLOTMENT, CRON, type CronJob, invalidConfigJobs, runCron, runCronFor } from "../../src/worker/cron.ts";

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

describe("cron: a tick under an invalid config", () => {
  const spy = (name: string) => {
    const run = vi.fn(async () => ({ more: false }));
    return { job: { name, run } as CronJob<object, object | undefined>, run };
  };

  it("COST-16 runs only the config-free jobs, with the problems, on the five-minute trigger", async () => {
    const [hourly, daily, five, breaker] = ["hourly", "daily", "five", "breaker"].map(spy) as ReturnType<typeof spy>[];
    const jobs = { [CRON.hourly]: [hourly?.job], [CRON.daily]: [daily?.job], [CRON.fiveMinutes]: [five?.job] };
    const whenInvalid = vi.fn((_: string[]) => ({ [CRON.fiveMinutes]: [breaker?.job] }));
    const invalid = { ok: false as const, problems: ["CAP_POOL_CONVERT: bad"] };
    for (const cron of Object.values(CRON)) await runCronFor(cron, {}, invalid, jobs as never, whenInvalid as never);
    expect(whenInvalid).toHaveBeenCalledWith(["CAP_POOL_CONVERT: bad"]);
    expect(breaker?.run).toHaveBeenCalledTimes(1);
    for (const j of [hourly, daily, five]) expect(j?.run).not.toHaveBeenCalled();
  });

  it("COST-16 the invalid-config set holds the one job on the five-minute trigger and nothing else", () => {
    const job = spy("breaker").job;
    const set = invalidConfigJobs(job);
    expect(Object.keys(set)).toEqual([CRON.fiveMinutes]);
    expect(set[CRON.fiveMinutes]).toEqual([job]);
  });

  it("a valid config runs the trigger's own jobs and never asks for the invalid-config set", async () => {
    const [hourly, breaker] = ["hourly", "breaker"].map(spy) as ReturnType<typeof spy>[];
    const whenInvalid = vi.fn(() => ({ [CRON.fiveMinutes]: [breaker?.job] }));
    await runCronFor(
      CRON.hourly,
      {},
      { ok: true, config: {} },
      { [CRON.hourly]: [hourly?.job] } as never,
      whenInvalid as never,
    );
    expect(hourly?.run).toHaveBeenCalledTimes(1);
    expect(whenInvalid).not.toHaveBeenCalled();
    expect(breaker?.run).not.toHaveBeenCalled();
  });
});
