// The one place the Worker picks its GuestDrop. Swapping the storage (ADR 0005 fallback) is a change here.
import { dbOf } from "../../auth/db.ts";
import type { Config } from "../../config.ts";
import type { Env } from "../../env.ts";
import type { GuestDrop } from "./index.ts";
import { bucketOf, R2GuestDrop } from "./r2.ts";

export const guestDropFor = (env: Env, config: Config): GuestDrop =>
  new R2GuestDrop(bucketOf(env.GUEST_FILES), dbOf(env.DB), config.guestStorageBudgetBytes);

/** An object is deleted at its session's end; anything older than this is a leftover (architecture 4.3). */
export const SWEEP_AGE_MS = 2 * 60 * 60 * 1000;

/** The hourly backstop. */
export async function sweepGuestFiles(env: Env, config: Config): Promise<number> {
  return guestDropFor(env, config).sweep(SWEEP_AGE_MS);
}
