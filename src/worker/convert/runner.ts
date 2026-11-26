// The Converter's alarm machine, over injected dependencies so it runs under Node against fakes (the Durable Object
// in do/converter.ts only wires them). One alarm does one bounded unit of work and names the next phase; a throw is
// reserved for infrastructure faults, which the record counts (docs/conversion.md, ADR 0019).
import type { Db } from "../auth/db.ts";
import {
  type EnqueueSpec,
  enqueueSpecSchema,
  type JobRecord,
  newRecord,
  type Plan,
  RECORD_KEY,
  readJob,
  type Store,
  writeJob as writeRaw,
} from "../do/converter-schema.ts";
import type { Spend } from "../spend/client.ts";
import { isRetryable, MAX_ATTEMPTS } from "./codes.ts";
import { CHUNK_BYTES, CONTAINER_ERRORS, isDocument, KIND_BY_EXT, type StartBody, statusSchema } from "./contract.ts";
import { ContainerFault, Courier, FILE_CALL_MS } from "./courier.ts";
import { type Located, locate, type OwnerKind } from "./keys.ts";
import type { EndState, Notifier } from "./notify.ts";
import { decideGroups, type Group, sha256Hasher } from "./outputs.ts";
import type { ContainerPort } from "./port.ts";
import { containerEnv, deadlineSeconds, PROFILES } from "./profile.ts";
import {
  heartbeat,
  markCancelled,
  markFailed,
  markSkipped,
  type Outputs,
  publishDone,
  type RunKey,
  readRun,
  setStage,
  startAttempt,
} from "./results.ts";
import type { ConvBucket } from "./store-types.ts";
import { nextUnit, prepare, putUnit, type StoreEnv } from "./store-units.ts";

export type { ConvBucket };

export interface RunnerDeps {
  store: Store;
  port: ContainerPort;
  spend: Spend;
  db: Db;
  bucket(name: Located["bucket"]): ConvBucket;
  notify: Notifier;
  /** CONVERT_MODE and the effective `convert` and `convert_video` switches, read per admit. */
  gates(): Promise<{ mode: "off" | "stub" | "on"; convert: string; convertVideo: string }>;
  leaseMaxSeconds: number;
  now(): number;
  /** 0 to 5000: spreads lease waits so one slot opening does not wake every waiter at once. */
  jitterMs(): number;
  sleep(ms: number): Promise<void>;
  /** A transform that errors unless exactly `size` bytes pass: R2 and fetch need a known length. */
  lengthStream(size: number): TransformStream<Uint8Array, Uint8Array>;
  log(line: string): void;
}

export const LEASE_WAIT_LIMIT_MS = 30 * 60_000;
const BOOT_LIMIT_MS = 90_000;
const HEALTH_WINDOW_MS = 10_000;
const POLL_WINDOW_MS = 25_000;
const MAX_INFRA_ERRORS = 6;
const HEARTBEAT_EVERY_MS = 60_000;
const CLEANUP_AFTER_MS = 3_600_000;
const INPUT_CHUNKS_PER_ALARM = 4;

/**
 * Saves the record unless the run has already ended on disk: a cancel can finish a job while a case that read it
 * earlier is mid-await, and that case's stale copy must not revive it.
 */
async function writeJob(store: Store, j: JobRecord): Promise<void> {
  const cur = await readJob(store).catch(() => null);
  if (cur && cur.runId === j.runId && cur.end && !j.end) return;
  await writeRaw(store, j);
}

type Next =
  | { phase: JobRecord["phase"]; at?: number }
  | { fail: string }
  | { skip: string }
  | { done: true }
  | { cancelled: true }
  /** Another owner holds the row, or a cancel won the race: write nothing more. */
  | { abandon: true };

export type EnqueueResult = "queued" | "duplicate" | "busy";
export type CheckResult = "lost" | "done" | "expired" | "rearmed" | "live";

/** The container's codes this machine passes on; `upload_failed` is the chunks not adding up. */
const mapContainerError = (code: string | null): string =>
  code === "upload_failed"
    ? "input_mismatch"
    : code && (CONTAINER_ERRORS as readonly string[]).includes(code)
      ? code
      : "internal";

const refusalStatus = (status: number): string =>
  status === 413
    ? "too_large"
    : status === 415
      ? "unsupported"
      : status === 422
        ? "input_mismatch"
        : status === 400
          ? "internal"
          : "interrupted";

const kindOf = (ext: string) => KIND_BY_EXT[ext as keyof typeof KIND_BY_EXT];

export class JobRunner {
  private readonly courier: Courier;

  constructor(private readonly d: RunnerDeps) {
    this.courier = new Courier(d.port, d.now);
  }

  // ------------------------------------------------------------------ entry points

  /** Wake-up: an unreadable record destroys the container and fails the row; a live job re-arms its stop. */
  async boot(): Promise<void> {
    let job: JobRecord | null;
    try {
      job = await readJob(this.d.store);
    } catch {
      await this.failUnreadable();
      return;
    }
    if (job && !job.end && job.deadline > 0 && this.d.port.running()) {
      await this.d.port.setInactivity(Math.max(1000, job.deadline - this.d.now()));
    }
  }

  async enqueue(raw: unknown): Promise<EnqueueResult> {
    const spec: EnqueueSpec = enqueueSpecSchema.parse(raw);
    const existing = await this.readSafe();
    if (existing && existing.phase !== "done") return existing.runId === spec.runId ? "duplicate" : "busy";
    if (existing) await this.d.store.deleteAll();
    await writeJob(this.d.store, newRecord(spec));
    await this.d.store.setAlarm(this.d.now());
    return "queued";
  }

  async cancel(runId: string): Promise<"wrong_run" | "cancelled" | "done"> {
    const j = await this.readSafe();
    if (!j || j.runId !== runId) return "wrong_run";
    if (j.phase === "done" || j.end) return "done";
    await this.finish(j, { state: "cancelled", code: null });
    return "cancelled";
  }

  /** The sweep's question: is this run alive, and if it is stuck, make it move or end. */
  async check(runId: string): Promise<CheckResult> {
    const j = await this.readSafe();
    if (!j || j.runId !== runId) return "lost";
    if (j.phase === "done") return "done";
    if (j.deadline > 0 && this.d.now() >= j.deadline && !j.end) {
      await this.route(j, { fail: "deadline" });
      return "expired";
    }
    if ((await this.d.store.getAlarm()) === null) {
      await this.d.store.setAlarm(this.d.now());
      return "rearmed";
    }
    return "live";
  }

  async alarm(): Promise<void> {
    const j = await this.readSafe();
    if (!j) return;
    if (j.phase === "done") {
      await this.d.store.deleteAll();
      return;
    }
    j.infraErrors++;
    await writeJob(this.d.store, j);
    if (j.infraErrors > MAX_INFRA_ERRORS && !j.end) return this.route(j, { fail: "interrupted" });
    if (j.phase !== "finish" && j.deadline > 0 && this.d.now() >= j.deadline)
      return this.route(j, { fail: "deadline" });
    this.courier.limitAt = j.deadline > 0 && j.phase !== "finish" ? j.deadline : null;
    return this.route(j, await this.cases[j.phase](j));
  }

  // ------------------------------------------------------------------ routing and the end

  private async readSafe(): Promise<JobRecord | null> {
    try {
      return await readJob(this.d.store);
    } catch {
      await this.failUnreadable();
      return null;
    }
  }

  private key = (j: JobRecord): RunKey => ({ fileId: j.fileId, version: j.version, runId: j.runId });
  private jobId = (j: JobRecord): string => `${j.fileId}_v${j.version}_a${j.attempt}`;
  private located = (j: JobRecord): Promise<Located | null> =>
    locate(this.d.db, j.ownerKind as OwnerKind, j.fileId, j.version);

  /** True while this run still owns the record: not cancelled, not replaced. */
  private async mine(j: JobRecord): Promise<boolean> {
    const cur = await this.readSafe();
    return !!cur && cur.runId === j.runId && cur.attempt === j.attempt && !cur.end && cur.phase !== "done";
  }

  /** Writes the case's changes and arms the next alarm, unless a cancel or another run got there first. */
  private async route(j: JobRecord, next: Next): Promise<void> {
    const cur = await this.readSafe();
    if (!cur || cur.runId !== j.runId || cur.phase === "done" || (cur.end && j.phase !== "finish")) return;
    if ("abandon" in next) return;
    if ("phase" in next) {
      j.infraErrors = 0;
      j.phase = next.phase;
      await writeJob(this.d.store, j);
      await this.d.store.setAlarm(next.at ?? this.d.now());
    } else if ("fail" in next) await this.fail(j, next.fail);
    else if ("skip" in next) await this.finish(j, { state: "skipped", code: next.skip });
    else if ("cancelled" in next) await this.finish(j, { state: "cancelled", code: null });
    else await this.finish(j, { state: "done", code: null });
  }

  /** A retryable code gets one new container while the version has starts left; anything else ends the run. */
  private async fail(j: JobRecord, code: string): Promise<void> {
    if (!isRetryable(code) || j.attempt >= MAX_ATTEMPTS || j.end) {
      await this.finish(j, { state: "failed", code });
      return;
    }
    await this.releaseAttempt(j);
    await this.deleteWritten(j);
    j.attempt++;
    Object.assign(j, {
      phase: "lease",
      leaseId: null,
      secondsTicket: null,
      secondsTaken: 0,
      takenAt: 0,
      deadline: 0,
      startedAt: 0,
      inputDone: 0,
      unit: 0,
      plan: null,
      lastStage: null,
      lastPct: 0,
      lastDone: 0,
      lastPushAt: 0,
      infraErrors: 0,
      released: false,
    } satisfies Partial<JobRecord>);
    await writeJob(this.d.store, j);
    await setStage(this.d.db, this.key(j), "waiting", this.d.now());
    await this.d.store.setAlarm(this.d.now());
  }

  /** Destroys the container, releases the lease and refunds the seconds the run did not use. Safe to repeat. */
  private async releaseAttempt(j: JobRecord): Promise<void> {
    // A container that will not die must not hold the lease hostage, nor be forgotten: release and refund, then throw
    // so the alarm retries the destroy.
    let stuck: unknown;
    try {
      await this.d.port.destroy();
    } catch (e) {
      stuck = e;
      this.d.log(JSON.stringify({ evt: "convert_destroy_failed", error: e instanceof Error ? e.message : "unknown" }));
    }
    if (j.leaseId && !j.released) {
      await this.d.spend.release(j.leaseId);
      j.released = true;
      await writeJob(this.d.store, j);
    }
    if (j.secondsTicket) {
      // Refund first, then forget the ticket: the guard honors each ticket once, so a repeat after a fault is harmless
      // and a lost refund never is.
      const ticket = j.secondsTicket;
      const unused = Math.min(ticket.n, j.secondsTaken - Math.ceil((this.d.now() - j.takenAt) / 1000));
      if (unused > 0) await this.d.spend.refund(ticket, unused);
      j.secondsTicket = null;
      await writeJob(this.d.store, j);
    }
    if (stuck) throw stuck;
  }

  /** The one end: every path (done, failed, skipped, cancelled) comes here, and each step may run again. */
  private async finish(j: JobRecord, end: NonNullable<JobRecord["end"]>): Promise<void> {
    j.end ??= end;
    j.phase = "finish";
    await writeJob(this.d.store, j);
    await this.releaseAttempt(j);
    const e = j.end;
    const now = this.d.now();
    if (e.state === "failed") await markFailed(this.d.db, this.key(j), e.code ?? "internal", now);
    else if (e.state === "skipped") await markSkipped(this.d.db, this.key(j), e.code ?? "busy", now);
    else if (e.state === "cancelled") await markCancelled(this.d.db, j.fileId, j.version, now, j.runId);
    if ((e.state === "done" || e.state === "failed") && !j.recorded) {
      // Flag first: a repeat of this step after a later fault must not count the run twice (the breaker reads the rate).
      j.recorded = true;
      await writeJob(this.d.store, j);
      await this.d.spend.record(e.state === "done" ? "conversion_done" : "conversion_failed", 1);
    }
    await this.d.notify.terminal(j.target, j.fileId, j.version, e.state as EndState, e.code);
    if (e.state !== "done") await this.deleteWritten(j);
    j.phase = "done";
    await writeJob(this.d.store, j);
    await this.d.store.setAlarm(this.d.now() + CLEANUP_AFTER_MS);
  }

  private async failUnreadable(): Promise<void> {
    await this.d.port.destroy().catch(() => undefined);
    const raw = (await this.d.store.get(RECORD_KEY)) as Record<string, unknown> | undefined;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    const leaseId = str(raw?.leaseId);
    if (leaseId) await this.d.spend.release(leaseId);
    const [fileId, runId] = [str(raw?.fileId), str(raw?.runId)];
    const version = typeof raw?.version === "number" ? raw.version : null;
    if (fileId && runId && version !== null) {
      await markFailed(this.d.db, { fileId, version, runId }, "internal", this.d.now());
    }
    await this.d.store.deleteAll();
  }

  private async deleteWritten(j: JobRecord): Promise<void> {
    if (j.written.length === 0) return;
    const bucket = this.d.bucket(j.ownerKind === "library" ? "LIBRARY" : "GUEST_FILES");
    for (let i = 0; i < j.written.length; i += 1000) await bucket.delete(j.written.slice(i, i + 1000));
    j.written = [];
    j.stored = [];
    await writeJob(this.d.store, j);
  }

  // ------------------------------------------------------------------ the phases

  private cases: Record<JobRecord["phase"], (j: JobRecord) => Promise<Next>> = {
    admit: (j) => this.admit(j),
    lease: (j) => this.lease(j),
    start: (j) => this.start(j),
    health: (j) => this.health(j),
    input: (j) => this.input(j),
    run: (j) => this.run(j),
    store: (j) => this.store(j),
    publish: (j) => this.publish(j),
    finish: async (j) => {
      await this.finish(j, j.end ?? { state: "failed", code: "internal" });
      return { abandon: true };
    },
    done: async () => ({ abandon: true }),
  };

  private async admit(j: JobRecord): Promise<Next> {
    const row = await readRun(this.d.db, j.fileId, j.version);
    if (!row || row.run_id !== j.runId || row.status !== "queued") return { cancelled: true };
    const loc = await this.located(j);
    if (!loc) return { cancelled: true };
    const kind = kindOf(loc.ext);
    if (!kind) return { fail: "unsupported" };
    const refused = await this.gateRefusal(j, kind);
    if (refused) return { skip: refused };
    if (deadlineSeconds(kind, loc.ext, loc.bytes, PROFILES[j.profile]) > this.d.leaseMaxSeconds)
      return { fail: "too_large" };
    j.sha256 = loc.sha256;
    return { phase: "lease" };
  }

  /** The switches, as they are now: the code to skip with, or null. A retry asks again, so a tripped breaker holds. */
  private async gateRefusal(j: JobRecord, kind: string | undefined): Promise<string | null> {
    const gates = await this.d.gates();
    if (gates.mode === "off" || gates.convert === "off") return "off";
    if (gates.convert === "account_only" && j.ownerKind === "guest" && j.profile === "full") return "account_only";
    if (kind === "video" && (j.profile === "demo" || gates.convertVideo === "off")) return "video_off";
    return null;
  }

  private async lease(j: JobRecord): Promise<Next> {
    const loc = await this.located(j);
    if (!loc) return { cancelled: true };
    if (j.attempt > 1) {
      const refused = await this.gateRefusal(j, kindOf(loc.ext));
      if (refused) return { skip: refused };
    }
    const seconds = deadlineSeconds(kindOf(loc.ext), loc.ext, loc.bytes, PROFILES[j.profile]);
    const pool = j.ownerKind === "library" && j.profile === "full" ? "convert" : "convert_public";
    // A lease already held (this alarm ran before, then failed after the acquire) is reused, never taken twice.
    if (!j.leaseId || j.released) {
      const got = await this.d.spend.acquire(pool, seconds);
      if (!got.ok) {
        if (this.d.now() - j.enqueuedAt > LEASE_WAIT_LIMIT_MS) return { skip: "busy" };
        await setStage(this.d.db, this.key(j), "waiting", this.d.now());
        return { phase: "lease", at: this.d.now() + got.retryAfterSeconds * 1000 + this.d.jitterMs() };
      }
      j.leaseId = got.leaseId;
      j.released = false;
      await writeJob(this.d.store, j);
    }
    if (!j.secondsTicket) {
      const taken = await this.d.spend.take("container_seconds", seconds);
      if (!taken.ok) {
        await this.releaseAttempt(j);
        return { skip: taken.reason === "cap_hit" ? "daily_budget" : "busy" };
      }
      j.secondsTicket = taken.ticket;
      j.secondsTaken = seconds;
      j.takenAt = this.d.now();
      j.deadline = j.takenAt + seconds * 1000;
    }
    if (!(await this.mine(j))) {
      await this.releaseAttempt(j);
      return { abandon: true };
    }
    return { phase: "start" };
  }

  private async start(j: JobRecord): Promise<Next> {
    const loc = await this.located(j);
    if (!loc) return { cancelled: true };
    if (this.d.port.running()) await this.d.port.destroy();
    if (!(await startAttempt(this.d.db, this.key(j), this.d.now()))) {
      const row = await readRun(this.d.db, j.fileId, j.version);
      if (row?.run_id !== j.runId || row.attempts < MAX_ATTEMPTS) return { cancelled: true };
      // The version used its starts in earlier runs: end this one for good.
      j.attempt = MAX_ATTEMPTS;
      return { fail: "start_failed" };
    }
    try {
      this.d.port.start(containerEnv(PROFILES[j.profile], loc.bytes));
      await this.d.port.setInactivity(Math.max(1000, j.deadline - this.d.now()));
    } catch (e) {
      this.d.log(JSON.stringify({ evt: "convert_start_failed", error: e instanceof Error ? e.message : "unknown" }));
      return { fail: "start_failed" };
    }
    j.startedAt = this.d.now();
    j.lastStage = "starting";
    if (!(await this.mine(j))) {
      await this.d.port.destroy();
      return { abandon: true };
    }
    return { phase: "health" };
  }

  private async health(j: JobRecord): Promise<Next> {
    const until = this.d.now() + HEALTH_WINDOW_MS;
    for (;;) {
      try {
        const res = await this.courier.call("GET", "/healthz");
        await this.courier.drain(res);
        if (res.ok) {
          await setStage(this.d.db, this.key(j), "upload", this.d.now());
          return { phase: "input" };
        }
      } catch {
        // not up yet
      }
      if (this.d.now() - j.startedAt > BOOT_LIMIT_MS) return { fail: "start_failed" };
      if (this.d.now() >= until) return { phase: "health" };
      await this.d.sleep(500);
    }
  }

  /** The original's SHA-256 when its row has none: one streaming read, native digest. */
  private async hashOriginal(loc: Located): Promise<string | null> {
    const obj = await this.d.bucket(loc.bucket).get(loc.originalKey);
    if (!obj) return null;
    const hash = sha256Hasher();
    const reader = obj.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return hash.hex();
      await hash.write(value);
    }
  }

  private async input(j: JobRecord): Promise<Next> {
    const loc = await this.located(j);
    if (!loc) return { cancelled: true };
    if (!this.d.port.running()) return { fail: "interrupted" };
    const bucket = this.d.bucket(loc.bucket);
    const head = await bucket.head(loc.originalKey);
    if (!head) return { fail: "input_missing" };
    if (head.size !== loc.bytes) return { fail: "input_mismatch" };
    j.sha256 ??= await this.hashOriginal(loc);
    if (!j.sha256) return { fail: "input_missing" };
    const chunks = Math.max(1, Math.ceil(loc.bytes / CHUNK_BYTES));
    try {
      for (let sent = 0; j.inputDone < chunks && sent < INPUT_CHUNKS_PER_ALARM; sent++) {
        const n = j.inputDone;
        const length = Math.min(CHUNK_BYTES, loc.bytes - n * CHUNK_BYTES);
        const obj = await bucket.get(loc.originalKey, { range: { offset: n * CHUNK_BYTES, length } });
        if (!obj) return { fail: "input_missing" };
        const res = await this.courier.call("PUT", `/job/input/${n}`, {
          body: obj.body.pipeThrough(this.d.lengthStream(length)),
          headers: { "content-length": String(length) },
          timeoutMs: FILE_CALL_MS * 2,
        });
        await this.courier.drain(res);
        if (!res.ok) return { fail: refusalStatus(res.status) };
        j.inputDone = n + 1;
        await writeJob(this.d.store, j);
        if (!(await this.mine(j))) return { abandon: true };
      }
      if (j.inputDone < chunks) return { phase: "input" };
      const body: StartBody = { jobId: this.jobId(j), ext: loc.ext, size: loc.bytes, sha256: j.sha256, chunks };
      const res = await this.courier.call("POST", "/job/start", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      await this.courier.drain(res);
      return res.status === 202 ? { phase: "run" } : { fail: refusalStatus(res.status) };
    } catch (e) {
      if (e instanceof ContainerFault) return { fail: e.code };
      throw e;
    }
  }

  /** A 25 s window of polling the job: stage changes go to D1, page counts only to the watcher, once a second. */
  private async run(j: JobRecord): Promise<Next> {
    if (!this.d.port.running()) return { fail: "interrupted" };
    const stop = this.d.now() + POLL_WINDOW_MS;
    try {
      for (;;) {
        const parsed = statusSchema.safeParse(await this.courier.getJson("/job/status"));
        if (!parsed.success) return { fail: "interrupted" };
        const st = parsed.data;
        if (st.state === "failed") return { fail: mapContainerError(st.error) };
        if (st.state === "idle") return { fail: "interrupted" };
        const stageChanged = st.stage !== null && st.stage !== j.lastStage;
        if (stageChanged && st.stage) {
          if (!(await setStage(this.d.db, this.key(j), st.stage, this.d.now()))) return { cancelled: true };
          j.lastStage = st.stage;
        }
        const done = Math.max(j.lastDone, st.pages?.done ?? 0);
        if ((stageChanged || done > j.lastDone) && this.d.now() - j.lastPushAt >= 1000) {
          j.lastDone = done;
          j.lastPushAt = this.d.now();
          await this.d.notify.progress(
            j.target,
            j.fileId,
            j.version,
            j.lastStage ?? "convert",
            st.pages ? done : null,
            st.pages?.total ?? null,
          );
        }
        j.lastPct = Math.max(j.lastPct, st.pct);
        await this.beat(j);
        if (st.state === "done") return { phase: "store" };
        if (this.d.now() >= stop) return { phase: "run" };
        await this.d.sleep(1000);
      }
    } catch (e) {
      if (e instanceof ContainerFault) return { fail: e.code };
      throw e;
    }
  }

  private async beat(j: JobRecord): Promise<void> {
    if (this.d.now() - j.lastHeartbeat < HEARTBEAT_EVERY_MS) return;
    j.lastHeartbeat = this.d.now();
    await heartbeat(this.d.db, this.key(j), this.d.now());
  }

  /** One store unit per alarm; the file and its owner are re-checked before each. */
  private async store(j: JobRecord): Promise<Next> {
    const loc = await this.located(j);
    if (!loc) return { cancelled: true };
    const env: StoreEnv = {
      courier: this.courier,
      bucket: this.d.bucket(loc.bucket),
      loc,
      profile: PROFILES[j.profile],
      jobId: this.jobId(j),
      lengthStream: this.d.lengthStream,
      persist: (rec) => writeJob(this.d.store, rec),
      mine: (rec) => this.mine(rec),
      pageReady: () => this.d.notify.pageReady(j.target, j.fileId, j.version),
    };
    try {
      if (!j.plan) {
        const refused = await prepare(env, j);
        return refused ?? { phase: "store" };
      }
      const step = nextUnit(j.plan, env.profile.widths, j.unit);
      if (!step) return { phase: "publish" };
      if ((await putUnit(env, j, step.unit)) === "abandon") return { abandon: true };
      j.unit = step.index + 1;
      return { phase: nextUnit(j.plan, env.profile.widths, j.unit) ? "store" : "publish" };
    } catch (e) {
      if (e instanceof ContainerFault) return { fail: e.code };
      throw e;
    }
  }

  private async publish(j: JobRecord): Promise<Next> {
    const plan = j.plan as Plan;
    const loc = await this.located(j);
    if (!loc) return { cancelled: true };
    const kind = kindOf(loc.ext);
    if (!decideGroups(kind, new Set(plan.passed)).ok) return { fail: "output_invalid" };
    const has = (g: Group) => plan.passed.includes(g);
    const outputs: Outputs = {
      v: 1,
      groups: { slides: has("slides"), pdf: has("pdf"), notes: has("notes"), media: has("media"), image: has("image") },
      total: plan.total,
      rendered: plan.rendered,
      files: j.stored,
      packs: Object.fromEntries(
        j.stored
          .filter((s) => s.path.endsWith(".pack"))
          .map((s) => [s.path.slice("s/".length, -".pack".length), { size: s.size }]),
      ),
      ...(!loc.sha256 && j.sha256 ? { originalSha256: j.sha256 } : {}),
    };
    const published = await publishDone(
      this.d.db,
      this.key(j),
      {
        pages: isDocument(kind) ? plan.rendered : null,
        hasNotes: has("notes") && plan.noteCount > 0,
        hasMotion: plan.motion,
        fontsMissing: plan.fonts,
        outputs,
        bytes: j.stored.reduce((n, s) => n + s.size, 0),
      },
      this.d.now(),
    );
    if (published) return { done: true };
    // A publish that committed before its caller saw it answers false on the retry: that is done, not cancelled.
    const row = await readRun(this.d.db, j.fileId, j.version);
    return row?.status === "done" && row.run_id === j.runId ? { done: true } : { cancelled: true };
  }
}
