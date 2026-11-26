// The composition root of the upload pipeline: the real D1, the library bucket and the spend client behind `Deps`.
import { batchDbOf } from "../auth/db.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { readSettings } from "../settings.ts";
import { capOverridesOf } from "../spend/caps.ts";
import { spendFor } from "../spend/guard.ts";
import { effectiveAll } from "../spend/switches.ts";
import { multipartOver, type UploadBucket } from "./multipart.ts";
import type { Deps } from "./pipeline.ts";

/** The one cast from a bucket binding to the slice uploads use. */
export const bucketFor = (env: Pick<Env, "LIBRARY" | "GUEST_FILES">, which: "library" | "guest"): UploadBucket =>
  (which === "library" ? env.LIBRARY : env.GUEST_FILES) as unknown as UploadBucket;

export async function uploadDepsFor(env: Env, config: Config): Promise<Deps> {
  const settings = await readSettings(env);
  return {
    db: batchDbOf(env.DB),
    mp: multipartOver(bucketFor(env, "library")),
    spend: spendFor(env, () => capOverridesOf(settings)),
    config,
    now: Date.now,
  };
}

/** The `uploads` switch in force: on, readonly (no new upload, no new URL) or off (nothing but a cancel and a read). */
export const uploadsSwitch = async (env: Env): Promise<string> =>
  effectiveAll(env as unknown as Record<string, unknown>, await readSettings(env)).uploads;
