// The composition root of the upload pipeline: the real D1, both buckets and the spend client behind `Deps`.
import { dbOf } from "../auth/db.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { readSettings } from "../settings.ts";
import { capOverridesOf } from "../spend/caps.ts";
import { spendFor } from "../spend/guard.ts";
import { effectiveAll } from "../spend/switches.ts";
import { convertWhenReady } from "./convert-ready.ts";
import { multipartOver, type UploadBucket } from "./multipart.ts";
import type { Deps } from "./pipeline.ts";

/** The one cast from a bucket binding to the slice uploads use. */
export const bucketFor = (env: Pick<Env, "LIBRARY" | "GUEST_FILES">, which: "library" | "guest"): UploadBucket =>
  (which === "library" ? env.LIBRARY : env.GUEST_FILES) as unknown as UploadBucket;

/**
 * The pipeline's deps and the switches in force, from one settings read: `uploads` (the library's: on, readonly, no new
 * upload or URL, or off, nothing but a cancel and a read) and `guestFiles` (`stopped` refuses a guest's new upload).
 * `ctx` is the request's; null only where no request waits (the sweep), so a route cannot forget it and hold its
 * answer for a conversion start.
 */
export async function uploadContext(
  env: Env,
  config: Config,
  ctx: Pick<ExecutionContext, "waitUntil"> | null,
): Promise<{ d: Deps; uploads: string; guestFiles: string }> {
  const settings = await readSettings(env);
  const switches = effectiveAll(env as unknown as Record<string, unknown>, settings);
  return {
    d: {
      db: dbOf(env.DB),
      mp: multipartOver(bucketFor(env, "library")),
      guestMp: multipartOver(bucketFor(env, "guest")),
      spend: spendFor(env, () => capOverridesOf(settings)),
      config,
      now: Date.now,
      afterReady: convertWhenReady(env, ctx),
    },
    uploads: switches.uploads,
    guestFiles: switches.guest_files,
  };
}

export const uploadDepsFor = async (env: Env, config: Config): Promise<Deps> =>
  (await uploadContext(env, config, null)).d;
