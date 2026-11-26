// The cron jobs by trigger. A stream adds its job to one list; every trigger in CRON must have a list.
import type { Config } from "./config.ts";
import { CRON, type CronJob, type CronTrigger } from "./cron.ts";
import type { Env } from "./env.ts";
import { closeStaleSessions, runRetention } from "./retention.ts";
import { sweepGuestFiles } from "./seams/guest-drop/select.ts";
import { runSpendBreaker } from "./spend/guard.ts";

export const JOBS: Readonly<Record<CronTrigger, readonly CronJob<Env, Config>[]>> = {
  [CRON.fiveMinutes]: [
    {
      name: "spend_breaker",
      run: async (env) => {
        await runSpendBreaker(env);
        return { more: false };
      },
    },
  ],
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
  ],
  [CRON.daily]: [
    {
      name: "retention",
      run: async (env, config) => {
        console.log(JSON.stringify({ evt: "retention", ...(await runRetention(env, config)) }));
        return { more: false };
      },
    },
  ],
};
