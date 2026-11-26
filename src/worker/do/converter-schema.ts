// The Converter's one stored record (`v: 1`), parsed on every wake: a record that does not parse is destroyed and the
// row failed, never trusted. A shape change is a new `v` read by a numbered step (CLAUDE.md, Durable Object schema).
import { z } from "zod";
import { KINDS } from "../convert/contract.ts";

export const PHASES = [
  "admit",
  "lease",
  "start",
  "health",
  "input",
  "run",
  "store",
  "publish",
  "finish",
  "done",
] as const;
export type Phase = (typeof PHASES)[number];

const int = z.number().int().nonnegative();
const ticket = z.strictObject({
  id: z.string(),
  meter: z.enum(["container_seconds", "upload_user", "upload_user_bytes"]),
  n: z.number().int().positive(),
});
const groups = z.array(z.enum(["slides", "pdf", "notes", "media", "image"]));

export const TERMINAL_STATES = ["done", "failed", "skipped", "cancelled"] as const;

/** Who hears about progress: a user's library, or the guest's screen. */
const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("library"), userId: z.string() }),
  z.strictObject({ kind: z.literal("guest"), screenRef: z.string() }),
]);

/** What the store learned from the manifest and the three JSON files; units after it only read this. */
const plan = z.strictObject({
  /** sha256 of the manifest the plan was checked against; a later unit that sees another manifest fails. */
  manifest: z.string(),
  rendered: int,
  total: int,
  /** Groups that passed every check so far. A failing unit removes its group. */
  passed: groups,
  /** `[w, h]` of each page's widest rendition, for the height of each stored image. */
  pages: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])),
  noteCount: int,
  motion: z.boolean(),
  media: z.boolean(),
  fonts: z.array(z.string()),
});

export const jobRecordSchema = z.strictObject({
  v: z.literal(1),
  runId: z.string(),
  attempt: z.number().int().min(1),
  phase: z.enum(PHASES),
  ownerKind: z.enum(["library", "guest"]),
  target,
  fileId: z.string(),
  version: z.number().int().positive(),
  profile: z.enum(["full", "demo"]),
  /** What the guard's pool and the per-day take were keyed by. */
  scope: z.string(),
  enqueuedAt: int,
  leaseId: z.string().nullable(),
  secondsTicket: ticket.nullable(),
  secondsTaken: int,
  takenAt: int,
  deadline: int,
  startedAt: int,
  inputDone: int,
  /** The original's SHA-256, from the file row or computed once. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  unit: int,
  plan: plan.nullable(),
  /** The stage and percent last pushed, so frames only rise. */
  lastStage: z.string().nullable(),
  lastPct: z.number().min(0).max(100),
  lastDone: int,
  lastPushAt: int,
  lastHeartbeat: int,
  /** Every key this run put, so a failure or cancel deletes them. */
  written: z.array(z.string()).max(64),
  stored: z.array(z.strictObject({ path: z.string(), size: int, sha256: z.string() })).max(64),
  infraErrors: int,
  released: z.boolean(),
  /** The end was counted for the breaker; set before the count so a repeated finish never counts twice. */
  recorded: z.boolean(),
  /** Set once: the run's end. `code` is set for failed and skipped. */
  end: z.strictObject({ state: z.enum(TERMINAL_STATES), code: z.string().nullable() }).nullable(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type Plan = z.infer<typeof plan>;
export type Target = z.infer<typeof target>;
export type Ticket = z.infer<typeof ticket>;

/** The spec `enqueue` takes: everything a record starts with, from the caller's checked request. */
export const enqueueSpecSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  ownerKind: z.enum(["library", "guest"]),
  target,
  fileId: z.string().min(1).max(64),
  version: z.number().int().positive(),
  profile: z.enum(["full", "demo"]),
  scope: z.string().max(128),
  enqueuedAt: int,
});
export type EnqueueSpec = z.infer<typeof enqueueSpecSchema>;

export const kindSchema = z.enum(KINDS);

/** The record's storage key, and a minimal storage the runner needs (a fake in tests). */
export const RECORD_KEY = "job";
export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** The record, or null when none exists; throws on a record that does not parse. */
export async function readJob(store: Store): Promise<JobRecord | null> {
  const raw = await store.get(RECORD_KEY);
  return raw === undefined ? null : jobRecordSchema.parse(raw);
}

export const writeJob = (store: Store, job: JobRecord): Promise<void> => store.put(RECORD_KEY, job);

export const newRecord = (spec: EnqueueSpec): JobRecord => ({
  v: 1,
  runId: spec.runId,
  attempt: 1,
  phase: "admit",
  ownerKind: spec.ownerKind,
  target: spec.target,
  fileId: spec.fileId,
  version: spec.version,
  profile: spec.profile,
  scope: spec.scope,
  enqueuedAt: spec.enqueuedAt,
  leaseId: null,
  secondsTicket: null,
  secondsTaken: 0,
  takenAt: 0,
  deadline: 0,
  startedAt: 0,
  inputDone: 0,
  sha256: null,
  unit: 0,
  plan: null,
  lastStage: null,
  lastPct: 0,
  lastDone: 0,
  lastPushAt: 0,
  lastHeartbeat: 0,
  written: [],
  stored: [],
  infraErrors: 0,
  released: false,
  recorded: false,
  end: null,
});
