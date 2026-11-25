// Zod-parsed Worker configuration. Fails closed: a bad value returns an error instead of a default.
// Covers the pairing variables so far; later modules add theirs to the schema.
import { z } from "zod";
import { SILENCE_MS } from "../../public/js/core/timing.js";
import { MIN_LENGTH_MINUTES } from "../../public/js/shared/length.js";
import { emailSet } from "./auth/email-norm.ts";
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
    FILE_ORIGIN: optional(
      z
        .url()
        .max(MAX_ORIGIN_CHARS)
        .refine((v) => new URL(v).origin === v, "an origin: scheme and host, no path or trailing slash"),
    ).describe(
      "The separate host that serves session links, bundles and previews (ADR 0018). Unset: no file-origin host, every workers.dev request redirects to PUBLIC_ORIGIN.",
    ),
    UPLOAD_MODE: z
      .enum(["direct", "proxy"])
      .default("proxy")
      .describe(
        "direct: the browser PUTs parts to the R2 EU endpoint on presigned URLs. proxy: parts go through the Worker, the fallback and the local path (ADR 0017).",
      ),
    UPLOAD_PART_BYTES: int(5_242_880, 134_217_728)
      .default(16_777_216)
      .describe("Bytes per multipart part; R2 requires at least 5 MiB for every part but the last."),
    UPLOAD_URL_TTL_SECONDS: int(60, 900).default(300).describe("A presigned part URL works this long."),
    LIBRARY_QUOTA_BYTES: int(1, Number.MAX_SAFE_INTEGER)
      .default(5_368_709_120)
      .describe("Library bytes one user may hold, trash included; an admin override per user outranks it."),
    LIBRARY_MAX_FILE_BYTES: int(1, Number.MAX_SAFE_INTEGER)
      .default(524_288_000)
      .describe("Largest single library file in bytes."),
    LIBRARY_MAX_FILES: int(1, 100_000)
      .default(2000)
      .describe("Library rows one user may hold; bounds the in-memory sorts and the count."),
    TRASH_DAYS: int(1, 365).default(30).describe("A trashed library file is purged after this many days."),
    INACTIVE_DAYS: int(30, 3650).default(365).describe("An account unused this long gets the inactivity warning."),
    INACTIVE_GRACE_DAYS: int(1, 365)
      .default(30)
      .describe("An inactive account is deleted this long after its warning."),
    ACCOUNT_DELETE_GRACE_DAYS: int(1, 90)
      .default(7)
      .describe("A requested account deletion can be cancelled for this long, then the purge runs."),
    INVITE_TTL_DAYS: int(1, 30).default(7).describe("An invite link works this long."),
    EMAIL_CODE_TTL_SECONDS: int(60, 3600).default(600).describe("An emailed code works this long."),
    REAUTH_SECONDS: int(30, 3600)
      .default(300)
      .describe("A fresh proof (code or passkey) unlocks sensitive account actions this long."),
    EMAIL_FROM: z.email().default("hi@bloop.here").describe("The sender of every bloop email."),
    TURNSTILE_SITE_KEY: optional(z.string().min(1)).describe(
      "The public Turnstile widget key; unset means the widget is not rendered.",
    ),
    LARGE_FILE_CHOICE_BYTES: int(1, Number.MAX_SAFE_INTEGER)
      .default(31_457_280)
      .describe("A presentation over this size gets the choice sheet: PowerPoint, slides here, or download."),
    CONVERT_MODE: z
      .enum(["off", "stub", "on"])
      .default("off")
      .describe(
        "off: no conversion starts. stub: the workflow writes fixed outputs and starts no container (tests). on: real conversion. An operational switch, not an access gate.",
      ),
    DEV_MAILBOX: z
      .enum(["0", "1"])
      .default("0")
      .describe(
        "Test only. 1 keeps outgoing mail in memory and serves it at GET /api/dev/mailbox; refused unless PUBLIC_ORIGIN is a local address.",
      ),
    R2_ACCOUNT_ID: optional(z.string().min(1)).describe(
      "Secret. The Cloudflare account id that names the R2 EU endpoint; never in the repo.",
    ),
    R2_ACCESS_KEY_ID: optional(z.string().min(1)).describe("Secret. R2 S3 access key id for presigning."),
    R2_SECRET_ACCESS_KEY: optional(z.string().min(1)).describe("Secret. R2 S3 secret key for presigning."),
    FILE_TOKEN_KEY: optional(z.string().min(32)).describe(
      "Secret. 32 random bytes that MAC preview tokens and the file-origin checks; at least 32 characters.",
    ),
    CODE_PEPPER: optional(z.string().min(32)).describe(
      "Secret. 32 random bytes that key the email-code MACs and the known-device cookie; at least 32 characters.",
    ),
    TURNSTILE_SECRET_KEY: optional(z.string().min(1)).describe("Secret. Turnstile server key for siteverify."),
    TALLY_SIGNING_SECRET: optional(z.string().min(1)).describe(
      "Secret. Signs the Tally waitlist webhook; the webhook fails closed while it is unset.",
    ),
    ADMIN_EMAILS: optional(z.string()).describe(
      "Secret. Comma-separated addresses that hold the admin role, checked per request (ADR 0014). An entry that does not normalize admits nobody.",
    ),
    TEST_EMAILS: optional(z.string()).describe(
      "Secret. Comma-separated test addresses: the only invitees and sign-ins in preview mode (ADR 0026).",
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
    if (v.DEV_MAILBOX === "1" && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
      issue("DEV_MAILBOX", "refused: PUBLIC_ORIGIN is not a local address");
    }
    if (v.FILE_ORIGIN) {
      if (new URL(v.FILE_ORIGIN).origin === new URL(v.PUBLIC_ORIGIN).origin) {
        issue("FILE_ORIGIN", "must differ from PUBLIC_ORIGIN");
      }
      if (!v.FILE_ORIGIN.startsWith("https://") && !isLocalOrigin(v.FILE_ORIGIN)) issue("FILE_ORIGIN", "must be https");
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

/** Library, upload and conversion settings (ADRs 0013, 0016, 0017, 0019). */
export interface LibraryConfig {
  /** FILE_ORIGIN, or null while the file host is off. */
  fileOrigin: string | null;
  uploadMode: "direct" | "proxy";
  partBytes: number;
  urlTtlSeconds: number;
  quotaBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  trashDays: number;
  largeFileChoiceBytes: number;
  convertMode: "off" | "stub" | "on";
}

/** Account and sign-in settings (ADRs 0013, 0014, 0026). */
export interface AccountConfig {
  inactiveDays: number;
  inactiveGraceDays: number;
  deleteGraceDays: number;
  inviteTtlDays: number;
  codeTtlSeconds: number;
  reauthSeconds: number;
  emailFrom: string;
  turnstileSiteKey: string | null;
  /** Normalized, so a lookup is `.has(emailNorm)`. */
  adminEmails: ReadonlySet<string>;
  testEmails: ReadonlySet<string>;
  devMailbox: boolean;
}

/** Secrets of the v4 features, each null while unset; a feature that needs one fails closed without it. */
export interface V4Secrets {
  r2AccountId: string | null;
  r2AccessKeyId: string | null;
  r2SecretAccessKey: string | null;
  fileTokenKey: string | null;
  codePepper: string | null;
  turnstileSecret: string | null;
  tallySecret: string | null;
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
  library: LibraryConfig;
  account: AccountConfig;
  secrets: V4Secrets;
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
      library: {
        fileOrigin: v.FILE_ORIGIN ?? null,
        uploadMode: v.UPLOAD_MODE,
        partBytes: v.UPLOAD_PART_BYTES,
        urlTtlSeconds: v.UPLOAD_URL_TTL_SECONDS,
        quotaBytes: v.LIBRARY_QUOTA_BYTES,
        maxFileBytes: v.LIBRARY_MAX_FILE_BYTES,
        maxFiles: v.LIBRARY_MAX_FILES,
        trashDays: v.TRASH_DAYS,
        largeFileChoiceBytes: v.LARGE_FILE_CHOICE_BYTES,
        convertMode: v.CONVERT_MODE,
      },
      account: {
        inactiveDays: v.INACTIVE_DAYS,
        inactiveGraceDays: v.INACTIVE_GRACE_DAYS,
        deleteGraceDays: v.ACCOUNT_DELETE_GRACE_DAYS,
        inviteTtlDays: v.INVITE_TTL_DAYS,
        codeTtlSeconds: v.EMAIL_CODE_TTL_SECONDS,
        reauthSeconds: v.REAUTH_SECONDS,
        emailFrom: v.EMAIL_FROM,
        turnstileSiteKey: v.TURNSTILE_SITE_KEY ?? null,
        adminEmails: emailSet(v.ADMIN_EMAILS),
        testEmails: emailSet(v.TEST_EMAILS),
        devMailbox: v.DEV_MAILBOX === "1",
      },
      secrets: {
        r2AccountId: v.R2_ACCOUNT_ID ?? null,
        r2AccessKeyId: v.R2_ACCESS_KEY_ID ?? null,
        r2SecretAccessKey: v.R2_SECRET_ACCESS_KEY ?? null,
        fileTokenKey: v.FILE_TOKEN_KEY ?? null,
        codePepper: v.CODE_PEPPER ?? null,
        turnstileSecret: v.TURNSTILE_SECRET_KEY ?? null,
        tallySecret: v.TALLY_SIGNING_SECRET ?? null,
      },
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
