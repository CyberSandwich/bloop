// Zod-parsed Worker configuration. Fails closed: a bad value returns an error instead of a default.
// Covers the pairing variables so far; later modules add theirs to the schema.
import { z } from "zod";
import { SILENCE_MS } from "../../public/js/core/timing.js";
import { MIN_LENGTH_MINUTES } from "../../public/js/shared/length.js";
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
    PUBLIC_ORIGIN: z
      .url()
      .max(MAX_ORIGIN_CHARS)
      .describe(
        "The deployed origin; .dev.vars overrides it locally. Capped so a /f/ link (origin, token, name) always fits the 200-character link budget (ADR 0003).",
      ),
    HASH_PEPPER: z.string().min(32).describe("Secret. Keyed hash for IP, code and session hashes at rest."),
    FILE_SOURCE: z
      .enum(["mock", "graph"])
      .default("mock")
      .describe("mock: the bundled demo account. graph: Microsoft Graph, which needs the Entra settings."),
    OPEN_PATH_MODE: z
      .enum(["redirect", "stream"])
      .default("redirect")
      .describe(
        "How /f/ serves a file: a 302 to the Graph URL, or streamed through the Worker (ADR 0003, field check T3).",
      ),
    LINK_FIRST_FETCH_SECONDS: z.coerce
      .number()
      .min(1)
      .default(600)
      .describe("A /f/ link never fetched dies this long after minting."),
    LINK_FETCH_WINDOW_SECONDS: z.coerce
      .number()
      .min(1)
      .default(120)
      .describe("After its first fetch a link lives this long."),
    LINK_MAX_FETCHES: int(1, 100).default(10).describe("Fetches one link allows; GET and HEAD both count."),
    LINK_MINTS_PER_ITEM: int(1, 50)
      .default(5)
      .describe("Links per approved item after its first, which is free (download, PDF or image view, a relaunch)."),
    LINK_BINDING_DEFAULT: z
      .enum(["off", "log", "enforce"])
      .default("log")
      .describe("Compare the fetching IP with the screen's: log records a mismatch, enforce refuses it."),
    TOKEN_MODE: z
      .enum(["refresh", "session"])
      .default("refresh")
      .describe(
        "refresh: keep a refresh token per user. session: none stored, a Microsoft redirect each session (ADR 0004).",
      ),
    GRANT_IDLE_DAYS: int(1, 90).default(30).describe("A stored grant unused this long is deleted."),
    AUDIT_RETENTION_DAYS: int(1, 3650)
      .default(180)
      .describe("Session and audit rows are deleted after this many days."),
    METRICS_RETENTION_DAYS: int(1, 3650)
      .default(90)
      .describe("Metric events are rolled into daily counts after this many days."),
    DEMO_RETENTION_DAYS: int(1, 3650)
      .default(7)
      .describe("Demo session, audit and metric rows are deleted after this many days."),
    IT_EXPORT_TOKEN: optional(z.string().min(32)).describe(
      "Secret. Bearer token for the IT export; at least 32 characters. The export answers 401 while it is unset.",
    ),
    GRAPH_DOWNLOAD_HOSTS: z
      .string()
      .default("*.sharepoint.com,*.files.1drv.com,my.microsoftpersonalcontent.com")
      .describe("Comma-separated host patterns /f/ may redirect to; any other Graph download host is refused."),
    ENTRA_AUTHORITY: z
      .url()
      .default("https://login.microsoftonline.com/organizations/v2.0")
      .describe("The Entra issuer URL; must be https unless PUBLIC_ORIGIN is local."),
    ENTRA_CLIENT_ID: optional(z.string().min(1)).describe(
      "The Entra app registration's client id; required when FILE_SOURCE=graph.",
    ),
    ENTRA_CLIENT_SECRET: optional(z.string().min(1)).describe(
      "Secret. The Entra app's client secret; required when FILE_SOURCE=graph.",
    ),
    ENTRA_SCOPES: z
      .string()
      .default("openid offline_access Files.Read")
      .describe("Space-separated scopes; must include openid. offline_access is dropped at sign-in in session mode."),
    TOKEN_KEK_CURRENT: z.string().default("k1").describe("The id in TOKEN_KEKS that wraps new tokens."),
    TOKEN_KEKS: optional(keks).describe(
      "Secret. JSON of key id to base64 32-byte key-encryption keys; must hold TOKEN_KEK_CURRENT.",
    ),
    COOKIE_KEY: optional(key32).describe(
      "Secret. Base64 32-byte key that seals the OAuth state cookie; required when FILE_SOURCE=graph.",
    ),
    CODE_LENGTH: int(6, 7).describe("Characters in a pairing code."),
    CODE_TTL_SECONDS: z.coerce.number().min(1).describe("A pairing code lives this long; production floor 30."),
    CODE_GRACE_SECONDS: z.coerce
      .number()
      .min(0)
      .describe(
        "A code stays claimable this long after the screen rotates to its successor, and expires TTL plus this after issue; production floor 5.",
      ),
    CLAIM_TIMEOUT_SECONDS: z.coerce
      .number()
      .min(1)
      .describe("A claimed screen waits this long for approval before it starts over; production floor 60."),
    UPLOAD_TIMEOUT_SECONDS: z.coerce
      .number()
      .min(1)
      .describe("A guest upload that has not finished after this long is abandoned."),
    SESSION_MAX_MINUTES: z.coerce
      .number()
      .positive()
      .describe(
        "The latest a live session may end, counted from approval, whatever length the phone sets; production range 5 to 720.",
      ),
    DEMO_MAX_MINUTES: z.coerce
      .number()
      .positive()
      .describe("SESSION_MAX_MINUTES for a demo session; production range 5 to SESSION_MAX_MINUTES."),
    SESSION_DEFAULT_MINUTES: z.coerce
      .number()
      .positive()
      .default(60)
      .describe(
        "The length every session starts with until the phone changes it (POST /api/session/length), never past the mode's cap; production range 5 to SESSION_MAX_MINUTES.",
      ),
    DEMO_ENABLED: z
      .enum(["true", "false"])
      .describe("false refuses every demo create and every claim of a demo code (ADR 0007)."),
    GUEST_DROP: z
      .enum(["off", "open", "pass"])
      .describe(
        "Guest policy for live rooms: off, open (no host, no pass) or pass (a pass is required). Every drop waits for the Open click on the screen.",
      ),
    GUEST_MAX_BYTES: int(1, PLATFORM_BODY_CAP)
      .default(94_371_840)
      .describe("Largest guest upload in bytes; at most the platform's 100 MB request body cap."),
    DEMO_GUEST_MAX_BYTES: int(1, PLATFORM_BODY_CAP)
      .default(26_214_400)
      .describe("Largest guest upload in a demo room, in bytes."),
    DEMO_MAX_CONCURRENT: int(1, 10_000).default(100).describe("Demo screens alive at once, across all visitors."),
    DEMO_MAX_PER_IP: int(1, 10_000)
      .default(12)
      .describe("Demo screens one IP hash may hold at once, so one address cannot fill the cap."),
    GUEST_STORAGE_BUDGET_BYTES: int(1, Number.MAX_SAFE_INTEGER)
      .default(5_368_709_120)
      .describe("Live guest bytes allowed in R2 at once; past it a drop gets storage_full."),
    R2_CLASS_A_MONTHLY_CAP: int(1, Number.MAX_SAFE_INTEGER)
      .default(500_000)
      .describe(
        "R2 puts and lists bloop may perform per UTC calendar month: 50% of the free tier's 1M, because the billing period may not align with calendar months and any 30 days span two. At the cap drops get storage_full.",
      ),
    R2_CLASS_B_MONTHLY_CAP: int(1, Number.MAX_SAFE_INTEGER)
      .default(5_000_000)
      .describe(
        "R2 gets and heads per UTC calendar month: 50% of the free tier's 10M. At the cap /f/ reads of guest files answer upstream_failed (502).",
      ),
    TEST_TIMING: z
      .enum(["0", "1"])
      .default("0")
      .describe(
        "Test only, never set in a deployment. 1 lowers the production floors on the timing vars (so sub-minute values work), skips the platform rate-limit bindings, and is refused unless PUBLIC_ORIGIN is a local address.",
      ),
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
    // Every cap holds the shortest length the phone may set, or the length route refuses every request.
    const min = MIN_LENGTH_MINUTES;
    if (v.SESSION_MAX_MINUTES < min || v.SESSION_MAX_MINUTES > 720) issue("SESSION_MAX_MINUTES", `${min} to 720`);
    if (v.DEMO_MAX_MINUTES < min || v.DEMO_MAX_MINUTES > v.SESSION_MAX_MINUTES) {
      issue("DEMO_MAX_MINUTES", `${min} to SESSION_MAX_MINUTES`);
    }
    if (v.SESSION_DEFAULT_MINUTES < min || v.SESSION_DEFAULT_MINUTES > v.SESSION_MAX_MINUTES) {
      issue("SESSION_DEFAULT_MINUTES", `${min} to SESSION_MAX_MINUTES`);
    }
  });

/** Every variable the Worker parses, each with its `.describe()` meaning; docs point here instead of listing them. */
export const CONFIG_VARS = schema.shape;

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
  /** Links per approved item after its first, which is free (download, PDF or image view, a relaunch). */
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
  /** The live cap: the latest a session may end, from approval. */
  sessionMaxMinutes: number;
  /** The demo cap. */
  demoMaxMinutes: number;
  /** The length a session starts with, before the mode's cap. */
  sessionDefaultMinutes: number;
  /**
   * The longest a session can last from its claim (two claim windows, an upload, the live cap): the backstops that
   * close a lost session row or delete a leftover guest object wait at least this long (architecture 4.3).
   */
  longestSessionMs: number;
  demoEnabled: boolean;
  guestDrop: "off" | "open" | "pass";
  guestMaxBytes: number;
  demoGuestMaxBytes: number;
  demoMaxConcurrent: number;
  demoMaxPerIp: number;
  /** How long a demo screen holds one of the concurrent slots: a claim window plus the longest demo session. */
  demoHoldMs: number;
  guestStorageBudgetBytes: number;
  r2ClassAMonthlyCap: number;
  r2ClassBMonthlyCap: number;
  /** Test only: the platform rate-limit bindings are skipped; the exact limits in the objects stay on. */
  testTiming: boolean;
  /** An authed screen socket heard from within this is live (the OPEN-02 binding); TEST_TIMING shortens it. */
  socketSilenceMs: number;
  machine: MachineConfig;
}

/** Fixed, not configurable: the grace and rate rules the docs state. */
const MAX_CODES_PER_MINUTE = 6;
const ENDED_MIN_SECONDS = 3;
const CLOSE_AFTER_SECONDS = 600;
/** Short enough for a test to watch a binding hand over, long enough for one test's steps after a hello. */
export const TEST_SILENCE_MS = 4000;

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
        maxMints: v.LINK_MINTS_PER_ITEM,
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
      demoMaxMinutes: v.DEMO_MAX_MINUTES,
      sessionDefaultMinutes: v.SESSION_DEFAULT_MINUTES,
      longestSessionMs: (2 * v.CLAIM_TIMEOUT_SECONDS + v.UPLOAD_TIMEOUT_SECONDS + v.SESSION_MAX_MINUTES * 60) * 1000,
      demoEnabled: v.DEMO_ENABLED === "true",
      guestDrop: v.GUEST_DROP,
      guestMaxBytes: v.GUEST_MAX_BYTES,
      demoGuestMaxBytes: v.DEMO_GUEST_MAX_BYTES,
      demoMaxConcurrent: v.DEMO_MAX_CONCURRENT,
      demoMaxPerIp: v.DEMO_MAX_PER_IP,
      demoHoldMs: (v.CLAIM_TIMEOUT_SECONDS + v.DEMO_MAX_MINUTES * 60) * 1000,
      guestStorageBudgetBytes: v.GUEST_STORAGE_BUDGET_BYTES,
      r2ClassAMonthlyCap: v.R2_CLASS_A_MONTHLY_CAP,
      r2ClassBMonthlyCap: v.R2_CLASS_B_MONTHLY_CAP,
      testTiming: v.TEST_TIMING === "1",
      socketSilenceMs: v.TEST_TIMING === "1" ? TEST_SILENCE_MS : SILENCE_MS,
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
