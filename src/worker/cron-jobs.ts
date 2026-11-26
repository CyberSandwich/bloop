// The cron jobs by trigger. A stream adds its job to one list; every trigger in CRON must have a list.
import type { Config } from "./config.ts";
import { CRON, type CronJob, type CronTrigger } from "./cron.ts";
import type { Env } from "./env.ts";
import { runLibraryRetention } from "./library/retention.ts";
import { retentionDepsFor } from "./library/wiring.ts";
import { closeStaleSessions, runRetention } from "./retention.ts";
import { sweepGuestFiles } from "./seams/guest-drop/select.ts";
import { runSpendBreaker } from "./spend/guard.ts";

/**
 * The breaker's job. It needs no Config, so the same job runs when the config is invalid: `configProblems` (var
 * names) then makes it alert, and `notify` is the one place A wires email for both paths.
 */
export const spendBreakerJob = (configProblems?: readonly string[]): CronJob<Env, unknown> => ({
  name: "spend_breaker",
  run: async (env) => {
    await runSpendBreaker(env, undefined, configProblems);
    return { more: false };
  },
});

/** The library's due work: trash, requested deletions and holds each hour, the inactivity and orphan scans each day. */
const libraryJob = (daily: boolean): CronJob<Env, Config> => ({
  name: daily ? "library_daily" : "library_due",
  run: async (env, config) => {
    const report = await runLibraryRetention(env, config.account, await retentionDepsFor(env, config), { daily });
    console.log(JSON.stringify({ evt: "library_retention", ...report }));
    return { more: report.more };
  },
});

export const JOBS: Readonly<Record<CronTrigger, readonly CronJob<Env, Config>[]>> = {
  [CRON.fiveMinutes]: [spendBreakerJob()],
  [CRON.hourly]: [
    {
      name: "guest_files",
      run: async (env, config) => {
        const swept = await sweepGuestFiles(env, config);
        if (swept > 0) console.log(JSON.stringify({ evt: "hourly", swept }));
        return { more: false };
      },
    },
    {
      name: "stale_sessions",
      run: async (env, config) => {
        const closed = await closeStaleSessions(env, config, Date.now());
        if (closed > 0) console.log(JSON.stringify({ evt: "hourly", closed }));
        return { more: false };
      },
    },
    libraryJob(false),
  ],
  [CRON.daily]: [
    {
      name: "retention",
      run: async (env, config) => {
        console.log(JSON.stringify({ evt: "retention", ...(await runRetention(env, config)) }));
        return { more: false };
      },
    },
    libraryJob(true),
  ],
};
