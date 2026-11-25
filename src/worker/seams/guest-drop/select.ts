// The one place the Worker picks its GuestDrop. Swapping the storage (ADR 0005 fallback) is a change here.
import { dbOf } from "../../auth/db.ts";
import type { Config } from "../../config.ts";
import type { Env } from "../../env.ts";
import { type GuestDrop, sweepAgeMs } from "./index.ts";
import { bucketOf, R2GuestDrop } from "./r2.ts";

export const guestDropFor = (env: Env, config: Config): GuestDrop =>
  new R2GuestDrop(bucketOf(env.GUEST_FILES), dbOf(env.DB), config.guestStorageBudgetBytes, Date.now, {
    classA: config.r2ClassAMonthlyCap,
    classB: config.r2ClassBMonthlyCap,
  });

/** The hourly backstop. */
export async function sweepGuestFiles(env: Env, config: Config): Promise<number> {
  return guestDropFor(env, config).sweep(sweepAgeMs(config));
}
