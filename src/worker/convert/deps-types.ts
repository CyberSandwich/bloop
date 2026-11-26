// What start, cancel and the sweep need, as an interface: the Workers wiring is deps.ts, tests pass fakes.
import type { Db } from "../auth/db.ts";
import type { EnqueueSpec } from "../do/converter-schema.ts";
import type { Spend } from "../spend/client.ts";
import type { CheckResult, EnqueueResult } from "./runner.ts";

export interface ConverterHandle {
  enqueue(spec: EnqueueSpec): Promise<EnqueueResult>;
  cancel(runId: string): Promise<"wrong_run" | "cancelled" | "done">;
  check(runId: string): Promise<CheckResult>;
}

export interface ConvertDeps {
  db: Db;
  spend: Spend;
  converter(fileId: string, version: number): ConverterHandle;
  gates(): Promise<{ mode: "off" | "stub" | "on"; convert: string; convertVideo: string }>;
  leaseMaxSeconds: number;
  now(): number;
  newRunId(): string;
  log(line: string): void;
}
