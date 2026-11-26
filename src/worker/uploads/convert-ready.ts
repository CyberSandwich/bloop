// A library file that turns `ready` starts its conversion (docs/conversion.md): after the response when there is a
// request (`ctx`), inline in the sweep. Nothing here can fail the upload: the file is already ready.
import { convertDepsFor } from "../convert/deps.ts";
import { startConversion } from "../convert/start.ts";
import type { Env } from "../env.ts";
import type { Deps } from "./pipeline.ts";

/** A new library file is version 1. The owner comes from the file's row, so `scope` and `target` only fill the type. */
export const convertWhenReady =
  (env: Env, ctx: Pick<ExecutionContext, "waitUntil"> | null): NonNullable<Deps["afterReady"]> =>
  async ({ id, userId }) => {
    // startConversion catches its own errors, not those of building its deps.
    const start = (async () =>
      startConversion(convertDepsFor(env), {
        ownerKind: "library",
        fileId: id,
        version: 1,
        profile: "full",
        scope: userId,
        target: { kind: "library", userId },
      }))().catch((e) => console.error(JSON.stringify({ evt: "convert_start_error", error: String(e) })));
    if (ctx) ctx.waitUntil(start);
    else await start;
  };
