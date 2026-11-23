// Zod-parsed Worker configuration. Fails closed: a bad value returns an error instead of a default.
// Covers the pairing variables so far; later modules add theirs to the schema.
import { z } from "zod";
import type { Keks } from "./auth/vault.ts";
import type { MachineConfig } from "./machine.ts";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ORIGIN_CHARS = 120;
const PLATFORM_BODY_CAP = 100 * 1024 * 1024;

/** True for an origin on this machine. Test timing and the missing local jurisdiction hang off it. */
export const isLocalOrigin = (origin: string): boolean => LOCAL_HOSTS.has(new URL(origin).hostname);

/** 32 random bytes as standard base64. */
const key32 = z.string().refine((s) => /^[A-Za-z0-9+/]{43}=$/.test(s), "base64 of 32 bytes");
/** TOKEN_KEKS: a JSON object of kid to key. */
const keks = z.string().transform((text, ctx) => {
  try {
    return z.record(z.string().min(1), key32).parse(JSON.parse(text));
  } catch {
    ctx.addIssue({ code: "custom", message: 'JSON like {"k1":"<base64 of 32 bytes>"}' });
    return z.NEVER;
  }
});
/** An unset and an empty value both mean "absent": wrangler.jsonc ships empty strings for the owner to fill. */
const optional = <T extends z.ZodType>(type: T) => z.preprocess((v) => (v === "" ? undefined : v), type.optional());

const schema = z
  .object({
    /** Capped so a /f/ link (origin, token, name) always fits the 200-character link budget (ADR 0003). */
    PUBLIC_ORIGIN: z.url().max(MAX_ORIGIN_CHARS),
    HASH_PEPPER: z.string().min(32),
    FILE_SOURCE: z.enum(["mock", "graph"]).default("mock"),
    OPEN_PATH_MODE: z.enum(["redirect", "stream"]).default("redirect"),
    LINK_FIRST_FETCH_SECONDS: z.coerce.number().min(1).default(600),
    LINK_FETCH_WINDOW_SECONDS: z.coerce.number().min(1).default(120),
    LINK_MAX_FETCHES: int(1, 100).default(10),
    LINK_MINTS_PER_SESSION: int(0, 50).default(5),
    LINK_BINDING_DEFAULT: z.enum(["off", "log", "enforce"]).default("log"),
    TOKEN_MODE: z.enum(["refresh", "session"]).default("refresh"),
    GRANT_IDLE_DAYS: int(1, 90).default(30),
    AUDIT_RETENTION_DAYS: int(1, 3650).default(180),
    METRICS_RETENTION_DAYS: int(1, 3650).default(90),
    DEMO_RETENTION_DAYS: int(1, 3650).default(7),
    /** At least 32 characters; the export answers 401 while it is unset. */
    IT_EXPORT_TOKEN: optional(z.string().min(32)),
    GRAPH_DOWNLOAD_HOSTS: z.string().default("*.sharepoint.com,*.files.1drv.com,my.microsoftpersonalcontent.com"),
    ENTRA_AUTHORITY: z.url().default("https://login.microsoftonline.com/organizations/v2.0"),
    ENTRA_CLIENT_ID: optional(z.string().min(1)),
    ENTRA_CLIENT_SECRET: optional(z.string().min(1)),
    ENTRA_SCOPES: z.string().default("openid offline_access Files.Read"),
    TOKEN_KEK_CURRENT: z.string().default("k1"),
    TOKEN_KEKS: optional(keks),
    COOKIE_KEY: optional(key32),
    CODE_LENGTH: int(6, 7),
    CODE_TTL_SECONDS: z.coerce.number().min(1),
    CODE_GRACE_SECONDS: z.coerce.number().min(0),
    CLAIM_TIMEOUT_SECONDS: z.coerce.number().min(1),
    UPLOAD_TIMEOUT_SECONDS: z.coerce.number().min(1),
    SESSION_MAX_MINUTES: z.coerce.number().positive(),
    DEMO_SESSION_MINUTES: z.coerce.number().positive(),
    DEMO_ENABLED: z.enum(["true", "false"]),
    GUEST_DROP: z.enum(["off", "open", "pass"]),
    /** At most the platform's 100 MB request body cap. */
    GUEST_MAX_BYTES: int(1, PLATFORM_BODY_CAP).default(52_428_800),
    DEMO_GUEST_MAX_BYTES: int(1, PLATFORM_BODY_CAP).default(10_485_760),
    /** Demo screens alive at once, across all visitors. */
    DEMO_MAX_CONCURRENT: int(1, 10_000).default(50),
    GUEST_STORAGE_BUDGET_BYTES: int(1, Number.MAX_SAFE_INTEGER).default(5_368_709_120),
    /** Test only. "1" lowers the floors below and is refused unless PUBLIC_ORIGIN is a local address. */
    TEST_TIMING: z.enum(["0", "1"]).default("0"),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const test = v.TEST_TIMING === "1";
    if (v.FILE_SOURCE === "graph") {
      // Fails closed: the Graph source never runs on a partial configuration.
      if (!v.ENTRA_CLIENT_ID) issue("ENTRA_CLIENT_ID", "required when FILE_SOURCE=graph");
      if (!v.ENTRA_CLIENT_SECRET) issue("ENTRA_CLIENT_SECRET", "required when FILE_SOURCE=graph");
      if (!v.COOKIE_KEY) issue("COOKIE_KEY", "required when FILE_SOURCE=graph");
      if (!v.TOKEN_KEKS?.[v.TOKEN_KEK_CURRENT])
        issue("TOKEN_KEKS", "must hold TOKEN_KEK_CURRENT when FILE_SOURCE=graph");
      if (!v.ENTRA_AUTHORITY.startsWith("https://") && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
        issue("ENTRA_AUTHORITY", "must be https");
      }
      if (!v.ENTRA_SCOPES.split(/\s+/).includes("openid")) issue("ENTRA_SCOPES", "must include openid");
    }
    if (test && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
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

/** Present only when FILE_SOURCE=graph: the Entra app, the vault keys and the cookie key. */
export interface GraphConfig {
  authority: string;
  clientId: string;
  clientSecret: string;
  /** ENTRA_SCOPES as configured; `offline_access` is dropped at sign-in in session mode. */
  scopes: string[];
  keks: Keks;
  cookieKey: string;
}

/** The open path's limits (ADR 0003): how long and how often a /f/ link works. */
export interface LinkConfig {
  /** A link never fetched dies this long after minting. */
  firstFetchSeconds: number;
  /** After the first fetch a link lives this long. */
  fetchWindowSeconds: number;
  maxFetches: number;
  /** Extra links per session beyond the first (download, PDF, a relaunch). */
  maxMints: number;
  /** Compare the fetching IP with the screen's: `log` records a mismatch, `enforce` refuses it. */
  binding: "off" | "log" | "enforce";
}

export interface Config {
  origin: string;
  hashPepper: string;
  fileSource: "mock" | "graph";
  openPathMode: "redirect" | "stream";
  links: LinkConfig;
  tokenMode: "refresh" | "session";
  grantIdleDays: number;
  auditRetentionDays: number;
  metricsRetentionDays: number;
  demoRetentionDays: number;
  itExportToken: string | null;
  downloadHosts: string[];
  graph: GraphConfig | null;
  codeLength: number;
  uploadTimeoutSeconds: number;
  sessionMaxMinutes: number;
  demoSessionMinutes: number;
  demoEnabled: boolean;
  guestDrop: "off" | "open" | "pass";
  guestMaxBytes: number;
  demoGuestMaxBytes: number;
  demoMaxConcurrent: number;
  /** How long a demo screen holds one of the concurrent slots: a claim window plus one session. */
  demoHoldMs: number;
  guestStorageBudgetBytes: number;
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
      fileSource: v.FILE_SOURCE,
      openPathMode: v.OPEN_PATH_MODE,
      links: {
        firstFetchSeconds: v.LINK_FIRST_FETCH_SECONDS,
        fetchWindowSeconds: v.LINK_FETCH_WINDOW_SECONDS,
        maxFetches: v.LINK_MAX_FETCHES,
        maxMints: v.LINK_MINTS_PER_SESSION,
        binding: v.LINK_BINDING_DEFAULT,
      },
      tokenMode: v.TOKEN_MODE,
      grantIdleDays: v.GRANT_IDLE_DAYS,
      auditRetentionDays: v.AUDIT_RETENTION_DAYS,
      metricsRetentionDays: v.METRICS_RETENTION_DAYS,
      demoRetentionDays: v.DEMO_RETENTION_DAYS,
      itExportToken: v.IT_EXPORT_TOKEN ?? null,
      downloadHosts: v.GRAPH_DOWNLOAD_HOSTS.split(",")
        .map((h) => h.trim())
        .filter(Boolean),
      graph:
        v.FILE_SOURCE === "graph" && v.ENTRA_CLIENT_ID && v.ENTRA_CLIENT_SECRET && v.TOKEN_KEKS && v.COOKIE_KEY
          ? {
              authority: v.ENTRA_AUTHORITY,
              clientId: v.ENTRA_CLIENT_ID,
              clientSecret: v.ENTRA_CLIENT_SECRET,
              scopes: v.ENTRA_SCOPES.split(/\s+/).filter(Boolean),
              keks: { keys: v.TOKEN_KEKS, current: v.TOKEN_KEK_CURRENT },
              cookieKey: v.COOKIE_KEY,
            }
          : null,
      codeLength: v.CODE_LENGTH,
      uploadTimeoutSeconds: v.UPLOAD_TIMEOUT_SECONDS,
      sessionMaxMinutes: v.SESSION_MAX_MINUTES,
      demoSessionMinutes: v.DEMO_SESSION_MINUTES,
      demoEnabled: v.DEMO_ENABLED === "true",
      guestDrop: v.GUEST_DROP,
      guestMaxBytes: v.GUEST_MAX_BYTES,
      demoGuestMaxBytes: v.DEMO_GUEST_MAX_BYTES,
      demoMaxConcurrent: v.DEMO_MAX_CONCURRENT,
      demoHoldMs: (v.CLAIM_TIMEOUT_SECONDS + v.DEMO_SESSION_MINUTES * 60) * 1000,
      guestStorageBudgetBytes: v.GUEST_STORAGE_BUDGET_BYTES,
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
