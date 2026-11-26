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

/**
 * The pipeline's deps and the `uploads` switch in force, from one settings read: on, readonly (no new upload, no new
 * URL) or off (nothing but a cancel and a read).
 */
export async function uploadContext(env: Env, config: Config): Promise<{ d: Deps; uploads: string }> {
  const settings = await readSettings(env);
  return {
    d: {
      db: batchDbOf(env.DB),
      mp: multipartOver(bucketFor(env, "library")),
      spend: spendFor(env, () => capOverridesOf(settings)),
      config,
      now: Date.now,
    },
    uploads: effectiveAll(env as unknown as Record<string, unknown>, settings).uploads,
  };
}

export const uploadDepsFor = async (env: Env, config: Config): Promise<Deps> => (await uploadContext(env, config)).d;
