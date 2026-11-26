// The Workers wiring of ConvertDeps: the one place start, cancel and the sweep meet the platform.
import { dbOf } from "../auth/db.ts";
import { configFor } from "../config.ts";
import type { Env } from "../env.ts";
import { newRef } from "../ids.ts";
import { readSettings } from "../settings.ts";
import { resolveCaps } from "../spend/caps.ts";
import { spendFor } from "../spend/guard.ts";
import { effectiveAll } from "../spend/switches.ts";
import { converterStub } from "../stubs.ts";
import type { ConvertDeps } from "./deps-types.ts";

export function convertDepsFor(env: Env): ConvertDeps {
  const vars = env as unknown as Record<string, unknown>;
  const config = configFor(env);
  return {
    db: dbOf(env.DB),
    spend: spendFor(env, () => ({})),
    converter: (fileId, version) => converterStub(env, fileId, version),
    gates: async () => {
      const switches = effectiveAll(vars, await readSettings(env, { fresh: true }));
      return {
        mode: config.ok ? config.config.library.convertMode : "off",
        convert: switches.convert,
        convertVideo: switches.convert_video,
      };
    },
    leaseMaxSeconds: resolveCaps(vars).lease_max_convert_seconds,
    now: Date.now,
    newRunId: newRef,
    log: (line) => console.error(line),
  };
}
