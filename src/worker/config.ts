// Zod-parsed Worker configuration. Fails closed: a bad value returns an error instead of a default.
// The variables live in config/<area>.ts; this file composes them, adds the cross-variable rules and builds Config.
import { z } from "zod";
import { SILENCE_MS } from "../../public/js/core/timing.js";
import { emailSet } from "./auth/email-norm.ts";
import type { Keks } from "./auth/vault.ts";
import { type AccountConfig, accountVars } from "./config/account.ts";
import { coreVars, isLocalOrigin } from "./config/core.ts";
import { type LibraryConfig, libraryVars } from "./config/library.ts";
import { spendVars } from "./config/spend.ts";
import type { MachineConfig } from "./machine.ts";

export type { AccountConfig };
export { isLocalOrigin };

const schema = z.object({ ...coreVars, ...libraryVars, ...accountVars, ...spendVars }).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  const test = v.TEST_TIMING === "1";
  if (v.FILE_SOURCE === "graph") {
    // Fails closed: the Graph source never runs on a partial configuration.
    if (!v.ENTRA_CLIENT_ID) issue("ENTRA_CLIENT_ID", "required when FILE_SOURCE=graph");
    if (!v.ENTRA_CLIENT_SECRET) issue("ENTRA_CLIENT_SECRET", "required when FILE_SOURCE=graph");
    if (!v.COOKIE_KEY) issue("COOKIE_KEY", "required when FILE_SOURCE=graph");
    if (!v.TOKEN_KEKS?.[v.TOKEN_KEK_CURRENT]) issue("TOKEN_KEKS", "must hold TOKEN_KEK_CURRENT when FILE_SOURCE=graph");
    if (!v.ENTRA_AUTHORITY.startsWith("https://") && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
      issue("ENTRA_AUTHORITY", "must be https");
    }
    if (!v.ENTRA_SCOPES.split(/\s+/).includes("openid")) issue("ENTRA_SCOPES", "must include openid");
  }
  if (v.DEV_MAILBOX === "1" && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
    issue("DEV_MAILBOX", "refused: PUBLIC_ORIGIN is not a local address");
  }
  if (v.R2_DEV_ENDPOINT && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
    issue("R2_DEV_ENDPOINT", "refused: PUBLIC_ORIGIN is not a local address");
  }
  if (v.CONVERT_MODE === "stub" && !isLocalOrigin(v.PUBLIC_ORIGIN)) {
    issue("CONVERT_MODE", "stub refused: PUBLIC_ORIGIN is not a local address");
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
  // Under 2 minutes the typed time is usable about 1 s in 60 and every preset is hidden.
  const min = 2;
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

/** Secrets of the v4 features, each null while unset; a feature that needs one fails closed without it. */
interface V4Secrets {
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
        r2DevEndpoint: v.R2_DEV_ENDPOINT ?? null,
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
