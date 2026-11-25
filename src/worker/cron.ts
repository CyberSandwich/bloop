// The cron dispatcher. It stays free of worker imports so unit tests can load it; the jobs live in cron-jobs.ts. The
// dispatcher gives each job an allotment of rows or objects for the tick and records whether work is left, so a job
// pages its own backlog across ticks instead of running unbounded. One failing job never stops the others.

/** The `triggers.crons` entries of wrangler.jsonc. */
export const CRON = { fiveMinutes: "*/5 * * * *", hourly: "0 * * * *", daily: "30 3 * * *" } as const;

export type CronTrigger = (typeof CRON)[keyof typeof CRON];

/** Rows or objects one job may touch in one tick. */
export const ALLOTMENT = 500;

export interface CronJob<Env, Config> {
  name: string;
  /** Does at most `allotment` units of work and says whether more is left for the next tick. */
  run(env: Env, config: Config, allotment: number): Promise<{ more: boolean }>;
}

export type CronJobs<Env, Config> = Readonly<Record<string, readonly CronJob<Env, Config>[]>>;

/** Runs every job of a trigger in order. An unknown trigger runs nothing. */
export async function runCron<Env, Config>(
  cron: string,
  env: Env,
  config: Config,
  jobs: CronJobs<Env, Config>,
): Promise<void> {
  for (const job of jobs[cron] ?? []) {
    try {
      const { more } = await job.run(env, config, ALLOTMENT);
      if (more) console.log(JSON.stringify({ evt: "cron_more", job: job.name }));
    } catch {
      console.error(JSON.stringify({ evt: "cron_job_failed", job: job.name }));
    }
  }
}
