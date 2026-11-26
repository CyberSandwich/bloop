// A library file that turns `ready` starts its conversion (docs/conversion.md): after the response when there is a
// request (`ctx`), inline in the sweep. `startConversion` never throws.
import { convertDepsFor } from "../convert/deps.ts";
import { startConversion } from "../convert/start.ts";
import type { Env } from "../env.ts";
import type { Deps } from "./pipeline.ts";

/** A new library file is version 1; start.ts takes the owner from the file's row, so `scope` and `target` only satisfy the type. */
export const convertWhenReady =
  (env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): NonNullable<Deps["afterReady"]> =>
  async ({ id, userId }) => {
    const start = startConversion(convertDepsFor(env), {
      ownerKind: "library",
      fileId: id,
      version: 1,
      profile: "full",
      scope: userId,
      target: { kind: "library", userId },
    });
    if (ctx) ctx.waitUntil(start);
    else await start;
  };
