// What the store and the runner share: the bucket slice they use and the manifest read-and-check.
import type { Courier } from "./courier.ts";
import { type CheckedManifest, checkManifest } from "./outputs.ts";
import type { Profile } from "./profile.ts";

/** The slice of an R2 bucket the machine uses; the platform binding satisfies it. */
export interface ConvBucket {
  put(key: string, value: ReadableStream<Uint8Array> | string, options?: { sha256?: string }): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** The container's manifest, checked; `fault` names the first rule it broke. */
export async function checkManifestFor(
  courier: Courier,
  ctx: { jobId: string; ext: string; profile: Profile },
): Promise<CheckedManifest | { fault: string }> {
  const r = checkManifest(await courier.getJson("/out/manifest.json"), ctx);
  return r.ok ? r.checked : { fault: r.reason };
}
