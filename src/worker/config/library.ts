// The library, uploads, conversion and the file origin (ADRs 0013, 0016, 0017, 0018, 0019).
import { z } from "zod";
import { int, MAX_ORIGIN_CHARS, optional } from "./core.ts";

export const libraryVars = {
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
  INACTIVE_GRACE_DAYS: int(1, 365).default(30).describe("An inactive account is deleted this long after its warning."),
  LARGE_FILE_CHOICE_BYTES: int(1, Number.MAX_SAFE_INTEGER)
    .default(31_457_280)
    .describe("A presentation over this size gets the choice sheet: PowerPoint, slides here, or download."),
  CONVERT_MODE: z
    .enum(["off", "stub", "on"])
    .default("off")
    .describe(
      "off: no conversion starts. stub: the converter writes fixed outputs and starts no container (tests). on: real conversion. An operational switch, not an access gate.",
    ),
  R2_ACCOUNT_ID: optional(z.string().regex(/^[0-9a-f]{32}$/)).describe(
    "Secret. The Cloudflare account id that names the R2 EU endpoint; never in the repo.",
  ),
  R2_ACCESS_KEY_ID: optional(z.string().min(1)).describe("Secret. R2 S3 access key id for presigning."),
  R2_SECRET_ACCESS_KEY: optional(z.string().min(1)).describe("Secret. R2 S3 secret key for presigning."),
  FILE_TOKEN_KEY: optional(z.string().min(32)).describe(
    "Secret. 32 random bytes that MAC preview tokens and the file-origin checks; at least 32 characters.",
  ),
};

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
