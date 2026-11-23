// GuestDrop seam (docs/interfaces.md section 5). No R2 type crosses it: `r2.ts` adapts the bucket, so
// a Node or Screen-object chunk store (ADR 0005 fallback) replaces one file.
import type { DropError, FileType, Mode } from "../../../shared/protocol.ts";

export type GuestPolicy = "off" | "pass" | "open";

/** Demo screens always take drops (capped smaller); a live room uses its own policy, else the configured one. */
export const effectivePolicy = (room: GuestPolicy | null, mode: Mode, configured: GuestPolicy): GuestPolicy =>
  mode === "demo" ? "open" : (room ?? configured);

/** Thrown by `read` when this month's R2 operation cap is reached (meter.ts); the bytes stay in the bucket. */
export class QuotaExhausted extends Error {}

export type Reservation = { ok: true; r2Key: string } | { ok: false; error: DropError };

export interface Upload {
  /** The session id: ties the object to its session for deletion by session when no file ref exists yet. */
  sessionKey: string;
  /** From `reserve`. */
  r2Key: string;
  /** The display name, already sanitized; its extension is the declared type. */
  name: string;
  declaredType: FileType;
  /** Content-Length, required. */
  length: number;
  body: ReadableStream<Uint8Array>;
}

export interface GuestFile {
  r2Key: string;
  name: string;
  type: FileType;
  bytes: number;
  sha256: string;
}

export type Accepted = { ok: true; file: GuestFile } | { ok: false; error: DropError };

export interface GuestDrop {
  /** Streams to storage, then validates by range reads. Deletes the object on any failure. */
  accept(u: Upload, maxBytes: number): Promise<Accepted>;
  /** Throws `QuotaExhausted` when the month's class B cap is reached. */
  read(r2Key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  /** Idempotent. */
  delete(r2Key: string): Promise<void>;
  /** Deletes the session's object and ledger row: by its key when known, else by session. Returns whether an object existed. */
  purge(sessionId: string | null, r2Key: string | null): Promise<boolean>;
  /** Picks the object key and reserves budget for one session's file before any byte is stored: `storage_full` when it would pass the budget or the month's R2 operation caps are reached. */
  reserve(sessionId: string, bytes: number, name: string, type: FileType): Promise<Reservation>;
  /** Hourly backstop: deletes objects older than the given age. Returns the count. */
  sweep(olderThanMs: number): Promise<number>;
}

/** Pure checks over byte ranges (validate.ts). */
export interface RangeReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export type Validate = (
  r: RangeReader,
  declared: FileType,
) => Promise<{ ok: true; type: FileType } | { ok: false; error: DropError }>;

export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxCentralDirectoryBytes: 2 * 1024 * 1024,
  maxTotalUncompressed: 1024 * 1024 * 1024,
  maxEntryRatio: 200,
  /** The ratio rule applies from this size: tiny, repetitive parts legitimately pass 200:1. */
  ratioFloorBytes: 64 * 1024,
  /** The one entry inflated, to read its content types; never more than this. */
  maxContentTypesBytes: 256 * 1024,
  requiredParts: ["[Content_Types].xml", "ppt/presentation.xml"],
  refusedParts: [/^ppt\/vbaProject\.bin$/i, /^ppt\/activeX\//i, /\.bin$/i],
  refusedContentTypes: [/macroEnabled/i, /vbaProject/i],
} as const;
