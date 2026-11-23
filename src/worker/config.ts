// Zod-parsed Worker configuration. Fails closed: a bad value returns an error instead of a default.
// Covers the pairing variables so far; later modules add theirs to the schema.
import { z } from "zod";
import type { MachineConfig } from "./machine.ts";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const schema = z
  .object({
    PUBLIC_ORIGIN: z.url(),
    HASH_PEPPER: z.string().min(32),
    CODE_LENGTH: int(6, 7),
    CODE_TTL_SECONDS: z.coerce.number().min(1),
    CODE_GRACE_SECONDS: z.coerce.number().min(0),
    CLAIM_TIMEOUT_SECONDS: z.coerce.number().min(1),
    UPLOAD_TIMEOUT_SECONDS: z.coerce.number().min(1),
    SESSION_MAX_MINUTES: z.coerce.number().positive(),
    DEMO_SESSION_MINUTES: z.coerce.number().positive(),
    DEMO_ENABLED: z.enum(["true", "false"]),
    GUEST_DROP: z.enum(["off", "open", "pass"]),
    /** Test only. "1" lowers the floors below and is refused unless PUBLIC_ORIGIN is a local address. */
    TEST_TIMING: z.enum(["0", "1"]).default("0"),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const test = v.TEST_TIMING === "1";
    if (test && !LOCAL_HOSTS.has(new URL(v.PUBLIC_ORIGIN).hostname)) {
      return issue("TEST_TIMING", "refused: PUBLIC_ORIGIN is not a local address");
    }
    if (test) return;
    if (v.CODE_TTL_SECONDS < 30) issue("CODE_TTL_SECONDS", "at least 30");
    if (v.CODE_GRACE_SECONDS < 5) issue("CODE_GRACE_SECONDS", "at least 5");
    if (v.CLAIM_TIMEOUT_SECONDS < 60) issue("CLAIM_TIMEOUT_SECONDS", "at least 60");
    if (v.SESSION_MAX_MINUTES < 1 || v.SESSION_MAX_MINUTES > 240) issue("SESSION_MAX_MINUTES", "1 to 240");
    if (v.DEMO_SESSION_MINUTES < 1 || v.DEMO_SESSION_MINUTES > v.SESSION_MAX_MINUTES) {
      issue("DEMO_SESSION_MINUTES", "1 to SESSION_MAX_MINUTES");
    }
  });

export interface Config {
  origin: string;
  hashPepper: string;
  codeLength: number;
  uploadTimeoutSeconds: number;
  sessionMaxMinutes: number;
  demoSessionMinutes: number;
  demoEnabled: boolean;
  guestDrop: "off" | "open" | "pass";
  /** Test only: the platform rate-limit bindings are skipped; the exact limits in the objects stay on. */
  testTiming: boolean;
  machine: MachineConfig;
}

/** Fixed, not configurable: the grace and rate rules the docs state. */
const MAX_CODES_PER_MINUTE = 6;
const ENDED_MIN_SECONDS = 3;
const CLOSE_AFTER_SECONDS = 600;

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

export function parseConfig(env: Record<string, unknown>): ConfigResult {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const v = parsed.data;
  return {
    ok: true,
    config: {
      origin: new URL(v.PUBLIC_ORIGIN).origin,
      hashPepper: v.HASH_PEPPER,
      codeLength: v.CODE_LENGTH,
      uploadTimeoutSeconds: v.UPLOAD_TIMEOUT_SECONDS,
      sessionMaxMinutes: v.SESSION_MAX_MINUTES,
      demoSessionMinutes: v.DEMO_SESSION_MINUTES,
      demoEnabled: v.DEMO_ENABLED === "true",
      guestDrop: v.GUEST_DROP,
      testTiming: v.TEST_TIMING === "1",
      machine: {
        codeTtlSeconds: v.CODE_TTL_SECONDS,
        codeGraceSeconds: v.CODE_GRACE_SECONDS,
        claimTimeoutSeconds: v.CLAIM_TIMEOUT_SECONDS,
        closeAfterSeconds: CLOSE_AFTER_SECONDS,
        maxCodesPerMinute: MAX_CODES_PER_MINUTE,
        endedMinSeconds: ENDED_MIN_SECONDS,
      },
    },
  };
}

const cache = new WeakMap<object, ConfigResult>();

/** Parses once per env object. */
export function configFor(env: object): ConfigResult {
  let result = cache.get(env);
  if (!result) {
    result = parseConfig(env as Record<string, unknown>);
    cache.set(env, result);
  }
  return result;
}
