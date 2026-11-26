// Shared helpers and the variables every stream reads: pairing, sessions, sources, retention and the test switch.
import { z } from "zod";

export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const MAX_ORIGIN_CHARS = 120;
export const PLATFORM_BODY_CAP = 100 * 1024 * 1024;

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
export const optional = <T extends z.ZodType>(type: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), type.optional());

export const coreVars = {
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
  AUDIT_RETENTION_DAYS: int(1, 3650).default(180).describe("Session and audit rows are deleted after this many days."),
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
      "The latest a live session may end, counted from approval, whatever length the phone sets; production range 2 to 720.",
    ),
  DEMO_MAX_MINUTES: z.coerce
    .number()
    .positive()
    .describe("SESSION_MAX_MINUTES for a demo session; production range 2 to SESSION_MAX_MINUTES."),
  SESSION_DEFAULT_MINUTES: z.coerce
    .number()
    .positive()
    .default(60)
    .describe(
      "The length every session starts with until the phone changes it (POST /api/session/length), never past the mode's cap; production range 2 to SESSION_MAX_MINUTES.",
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
    .default(26_214_400)
    .describe(
      "Largest guest upload in bytes as one request body: 25 MB, past which a long streamed PUT is not served.",
    ),
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
};
