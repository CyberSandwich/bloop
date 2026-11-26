// The Converter's alarm machine over fakes: a clock, an in-memory storage and R2, the stub job server as the container,
// a recording spend guard and notifier, and a fault injector. Alarms are driven by hand, as the platform would.

import type { Notifier } from "../../src/worker/convert/notify.ts";
import { sha256Hex } from "../../src/worker/convert/outputs.ts";
import type { ContainerPort } from "../../src/worker/convert/port.ts";
import { claimRun } from "../../src/worker/convert/results.ts";
import { type ConvBucket, JobRunner, type RunnerDeps } from "../../src/worker/convert/runner.ts";
import { stubPort } from "../../src/worker/convert/stub.ts";
import { type EnqueueSpec, RECORD_KEY, type Store } from "../../src/worker/do/converter-schema.ts";
import type { Spend, TakeTicket } from "../../src/worker/spend/client.ts";
import { addGuest, type World, world } from "./convert-world.ts";

const enc = new TextEncoder();

export class FakeStore implements Store {
  map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string) {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.map.set(key, structuredClone(value));
  }
  async deleteAll() {
    this.map.clear();
    this.alarmAt = null;
  }
  async setAlarm(at: number) {
    this.alarmAt = at;
  }
  async getAlarm() {
    return this.alarmAt;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
}

export class FakeBucket implements ConvBucket {
  objects = new Map<string, Uint8Array>();
  /** Objects of a size with no bytes behind them: zero-filled on read. */
  virtual = new Map<string, number>();
  /** Runs after a put's body is read and before it lands: the window a cancel can fall into. */
  afterRead: ((key: string) => Promise<void>) | null = null;
  constructor(private readonly h: () => Harness) {}

  async put(key: string, value: ReadableStream<Uint8Array> | string, options?: { sha256?: string }) {
    this.h().tick(`bucket.put ${key}`);
    const bytes =
      typeof value === "string" ? enc.encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
    if (options?.sha256 && (await sha256Hex(bytes)) !== options.sha256) throw new Error("R2: sha256 mismatch");
    await this.afterRead?.(key);
    this.objects.set(key, bytes);
    this.h().events.push(`put ${key}`);
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    this.h().tick(`bucket.get ${key}`);
    const size = this.virtual.get(key);
    if (size !== undefined) {
      const { offset = 0, length = size } = options?.range ?? {};
      let left = length;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (left <= 0) return c.close();
          const n = Math.min(left, 1024 * 1024);
          left -= n;
          c.enqueue(new Uint8Array(n));
        },
      });
      void offset;
      return { body };
    }
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const { offset = 0, length = bytes.length } = options?.range ?? {};
    return { body: new Response(bytes.slice(offset, offset + length)).body as ReadableStream<Uint8Array> };
  }
  async head(key: string) {
    this.h().tick(`bucket.head ${key}`);
    const v = this.virtual.get(key);
    if (v !== undefined) return { size: v };
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length } : null;
  }
  async delete(keys: string | string[]) {
    this.h().tick("bucket.delete");
    for (const k of [keys].flat()) this.objects.delete(k);
  }
  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export class FakeSpend implements Spend {
  calls: string[] = [];
  busy = false;
  retryAfterSeconds = 20;
  capHit: string | null = null;
  acquired = 0;
  released = 0;
  refunds: { meter: string; n: number }[] = [];
  constructor(private readonly h: () => Harness) {}

  // biome-ignore lint/suspicious/noExplicitAny: the overloaded interface method
  take: any = async (meter: string, n: number) => {
    this.h().tick(`spend.take ${meter}`);
    this.calls.push(`take:${meter}`);
    if (this.capHit === meter) {
      return { ok: false, reason: "cap_hit", meter, period: "day", scope: "all", retryAfterSeconds: 3600 };
    }
    const refundable = meter === "container_seconds" || meter.startsWith("upload_");
    return refundable ? { ok: true, ticket: { id: `t${this.calls.length}`, meter, n } } : { ok: true };
  };
  async charge() {
    return { ok: true as const };
  }
  async acquire(pool: string) {
    this.h().tick("spend.acquire");
    this.calls.push(`acquire:${pool}`);
    if (this.busy) return { ok: false as const, reason: "busy" as const, retryAfterSeconds: this.retryAfterSeconds };
    this.acquired++;
    return { ok: true as const, leaseId: `lease${this.acquired}`, deadline: 0 };
  }
  async release(id: string) {
    this.h().tick("spend.release");
    this.calls.push(`release:${id}`);
    this.released++;
  }
  async record(meter: string) {
    this.calls.push(`record:${meter}`);
  }
  async refund(ticket: TakeTicket, n?: number) {
    this.h().tick("spend.refund");
    this.calls.push(`refund:${ticket.meter}`);
    this.refunds.push({ meter: ticket.meter, n: n ?? ticket.n });
  }
}

export class FakeNotify implements Notifier {
  progress_: { stage: string; done: number | null; at: number }[] = [];
  terminal_: { state: string; code: string | null }[] = [];
  constructor(private readonly h: () => Harness) {}
  async progress(_t: unknown, _f: string, _v: number, stage: string, done: number | null) {
    this.progress_.push({ stage, done, at: this.h().clock.t });
    this.h().events.push(`notify progress ${stage} ${done}`);
  }
  async pageReady() {
    this.h().events.push("notify pageReady");
  }
  async terminal(_t: unknown, _f: string, _v: number, state: string, code: string | null) {
    this.terminal_.push({ state, code });
    this.h().events.push(`notify terminal ${state}`);
  }
}

export interface Harness {
  w: World;
  store: FakeStore;
  bucket: FakeBucket;
  spend: FakeSpend;
  notify: FakeNotify;
  guestBucket: FakeBucket;
  clock: { t: number };
  runner: JobRunner;
  events: string[];
  portCalls: string[];
  posts: { jobId: string; chunks: number }[];
  puts: number[];
  starts: { env: Record<string, string> }[];
  destroys: number;
  inactivity: number[];
  gates: { mode: "off" | "stub" | "on"; convert: string; convertVideo: string };
  /** Fault injection: the call with this ordinal (counting every external call) throws once. */
  failAt: number | null;
  /** Answers a container request instead of the stub, or returns null to let the stub answer. */
  respond: ((path: string) => Response | null) | null;
  calls: number;
  /** Every external call so far, in order: what a fault ordinal means. */
  sites: string[];
  tick(site: string): void;
  thrown: number;
  runId: string;
}

export interface Options {
  mode?: string;
  ext?: string;
  bytes?: number;
  virtual?: boolean;
  profile?: "full" | "demo";
  ownerKind?: "library" | "guest";
  sha256?: string | null;
}

/** A library file (or a guest file) with a stub original, the machine around it, and nothing started. */
export function harness(o: Options = {}): Harness {
  const bytes = o.bytes ?? 1000;
  const w = world({ ext: o.ext ?? "pptx", bytes, sha256: o.sha256 === undefined ? "a".repeat(64) : o.sha256 });
  const guest = o.ownerKind === "guest";
  if (guest) addGuest(w.db, "g1", `talk.${o.ext ?? "pptx"}`, bytes);
  const h: Harness = {
    w,
    store: new FakeStore(),
    bucket: new FakeBucket(() => h),
    guestBucket: new FakeBucket(() => h),
    spend: new FakeSpend(() => h),
    notify: new FakeNotify(() => h),
    clock: { t: 1_000_000 },
    events: [],
    portCalls: [],
    posts: [],
    puts: [],
    starts: [],
    destroys: 0,
    inactivity: [],
    gates: { mode: "stub", convert: "on", convertVideo: "on" },
    failAt: null,
    respond: null,
    calls: 0,
    sites: [],
    thrown: 0,
    runId: "run1",
    tick(site) {
      h.calls++;
      h.sites.push(site);
      if (h.failAt === h.calls) {
        h.failAt = null;
        throw new Error(`injected fault at ${site}`);
      }
    },
    runner: undefined as unknown as JobRunner,
  };
  const original = `BLOOP-STUB:${o.mode ?? ""}`;
  const data = new Uint8Array(bytes);
  data.set(enc.encode(original).subarray(0, bytes));
  const key = guest ? "g/g1" : w.originalKey;
  const bucket = guest ? h.guestBucket : h.bucket;
  if (o.virtual) bucket.virtual.set(key, bytes);
  else bucket.objects.set(key, data);

  const inner = stubPort(h.store, () => h.clock.t);
  const port: ContainerPort = {
    start(env) {
      h.tick("port.start");
      h.starts.push({ env });
      h.events.push("container start");
      inner.start(env);
    },
    running: () => inner.running(),
    async destroy() {
      h.tick("port.destroy");
      if (inner.running()) {
        h.destroys++;
        h.events.push("container destroy");
      }
      await inner.destroy();
    },
    setInactivity: async (ms) => {
      h.inactivity.push(ms);
      await inner.setInactivity(ms);
    },
    async fetch(path, init) {
      h.tick(`port.fetch ${path}`);
      if (path.startsWith("/job/input/")) h.puts.push(Number(path.slice("/job/input/".length)));
      if (path === "/job/start") h.posts.push(JSON.parse(String(init.body)));
      return h.respond?.(path) ?? inner.fetch(path, init);
    },
  };
  const deps: RunnerDeps = {
    store: h.store,
    port,
    spend: h.spend,
    db: w.db,
    bucket: (name) => (name === "LIBRARY" ? h.bucket : h.guestBucket),
    notify: h.notify,
    gates: async () => h.gates,
    leaseMaxSeconds: 1800,
    now: () => h.clock.t,
    jitterMs: () => 1234,
    sleep: async (ms) => {
      h.clock.t += ms;
    },
    lengthStream: (size) => {
      let n = 0;
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          n += chunk.length;
          if (n > size) throw new Error("FixedLengthStream: too many bytes");
          c.enqueue(chunk);
        },
        flush() {
          if (n !== size) throw new Error("FixedLengthStream: too few bytes");
        },
      });
    },
    log: () => undefined,
  };
  h.runner = new JobRunner(deps);
  return h;
}

export function specFor(h: Harness, o: Options = {}, over: Partial<EnqueueSpec> = {}): EnqueueSpec {
  const guest = o.ownerKind === "guest";
  return {
    runId: h.runId,
    ownerKind: guest ? "guest" : "library",
    target: guest ? { kind: "guest", screenRef: "screen1" } : { kind: "library", userId: h.w.userId },
    fileId: guest ? "g1" : h.w.fileId,
    version: 1,
    profile: o.profile ?? "full",
    scope: h.w.userId,
    enqueuedAt: h.clock.t,
    ...over,
  };
}

/** What `startConversion` does at the end: claim the row, hand the Converter its run. */
export async function begin(h: Harness, o: Options = {}): Promise<void> {
  const spec = specFor(h, o);
  const claimed = await claimRun(h.w.db, {
    fileId: spec.fileId,
    version: 1,
    ownerKind: spec.ownerKind,
    runId: spec.runId,
    now: h.clock.t,
  });
  if (!claimed) throw new Error("claim refused");
  await h.runner.enqueue(spec);
}

/** Runs alarms in time order until the job is over; an alarm that throws is retried as the platform does. */
export async function drive(h: Harness, max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    const rec = (await h.store.get(RECORD_KEY)) as { phase: string } | undefined;
    if (!rec || rec.phase === "done" || h.store.alarmAt === null) return;
    h.clock.t = Math.max(h.clock.t, h.store.alarmAt);
    h.store.alarmAt = null;
    try {
      await h.runner.alarm();
    } catch {
      h.thrown++;
      h.store.alarmAt ??= h.clock.t + 2000;
    }
  }
  throw new Error("drive: the job did not finish");
}

/** Alarms until the record is in `phase` (the next alarm would run it), or the job ends. */
export async function stepTo(h: Harness, phase: string, max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    const rec = (await h.store.get(RECORD_KEY)) as { phase: string };
    if (rec.phase === phase || rec.phase === "done") return;
    h.clock.t = Math.max(h.clock.t, h.store.alarmAt as number);
    h.store.alarmAt = null;
    await h.runner.alarm();
  }
}

export const derived = (h: Harness) =>
  h.w.db.raw.prepare("SELECT * FROM derived").get() as Record<string, unknown> | undefined;
