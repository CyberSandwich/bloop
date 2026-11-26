// One per file version (idFromName("<fid>:v<n>"), eu): owns the container for one conversion and checks every output
// before it is stored (ADR 0019). All the logic is convert/runner.ts, which runs under Node over fakes; this class only
// wires the platform to it.
import { DurableObject } from "cloudflare:workers";
import { dbOf } from "../auth/db.ts";
import { configFor } from "../config.ts";
import { notifierFor } from "../convert/notify.ts";
import { realPort } from "../convert/port.ts";
import {
  type CheckResult,
  type ConvBucket,
  type EnqueueResult,
  JobRunner,
  type RunnerDeps,
} from "../convert/runner.ts";
import { stubPort } from "../convert/stub.ts";
import type { Env } from "../env.ts";
import { readSettings } from "../settings.ts";
import { resolveCaps } from "../spend/caps.ts";
import { spendFor } from "../spend/guard.ts";
import { effectiveAll } from "../spend/switches.ts";
import { screenStub, userLibraryStub } from "../stubs.ts";
import type { EnqueueSpec } from "./converter-schema.ts";

const bucketOf = (binding: R2Bucket): ConvBucket => binding as unknown as ConvBucket;

export class Converter extends DurableObject<Env> {
  private readonly runner: JobRunner;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const vars = env as unknown as Record<string, unknown>;
    const config = configFor(env);
    const mode = config.ok ? config.config.library.convertMode : "off";
    const deps: RunnerDeps = {
      store: ctx.storage,
      port: mode === "stub" ? stubPort(ctx.storage) : realPort(ctx),
      spend: spendFor(env, () => ({})),
      db: dbOf(env.DB),
      bucket: (name) => bucketOf(env[name]),
      notify: notifierFor((t) =>
        t.kind === "library" ? userLibraryStub(env, t.userId) : screenStub(env, t.screenRef),
      ),
      gates: async () => {
        const switches = effectiveAll(vars, await readSettings(env, { fresh: true }));
        return { mode, convert: switches.convert, convertVideo: switches.convert_video };
      },
      leaseMaxSeconds: resolveCaps(vars).lease_max_convert_seconds,
      now: Date.now,
      jitterMs: () => Math.floor(Math.random() * 5000),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      lengthStream: (size) => new FixedLengthStream(size),
      log: (line) => console.error(line),
    };
    this.runner = new JobRunner(deps);
    ctx.blockConcurrencyWhile(() => this.runner.boot());
  }

  enqueue(spec: EnqueueSpec): Promise<EnqueueResult> {
    return this.runner.enqueue(spec);
  }

  cancel(runId: string): Promise<"wrong_run" | "cancelled" | "done"> {
    return this.runner.cancel(runId);
  }

  check(runId: string): Promise<CheckResult> {
    return this.runner.check(runId);
  }

  override alarm(): Promise<void> {
    return this.runner.alarm();
  }
}
