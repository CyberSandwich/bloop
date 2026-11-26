// GuestDrop seam (docs/interfaces.md section 5). No R2 type crosses it: `r2.ts` adapts the bucket, so
// a Node or Screen-object chunk store (ADR 0005 fallback) replaces one file.
import type { DropError, FileType, Mode } from "../../../shared/protocol.ts";
import type { Config } from "../../config.ts";
import { newRef } from "../../ids.ts";
import type { ByteRange } from "../open-path/range.ts";
import type { OpClass } from "./meter.ts";

export type GuestPolicy = "off" | "pass" | "open";

/** Clock skew and the hourly schedule's own lag. */
const SWEEP_SLACK_MS = 10 * 60 * 1000;

/**
 * An object is deleted at its session's end; one older than the longest session (an upload, the offer, the cap) is a
 * leftover for the hourly sweep (architecture 4.3). A fixed age would delete the file of a session the phone made longer.
 */
export const sweepAgeMs = (config: Pick<Config, "longestSessionMs">): number =>
  config.longestSessionMs + SWEEP_SLACK_MS;

/** Demo screens always take drops (capped smaller); a live room uses its own policy, else the configured one. */
export const effectivePolicy = (room: GuestPolicy | null, mode: Mode, configured: GuestPolicy): GuestPolicy =>
  mode === "demo" ? "open" : (room ?? configured);

/** Thrown by `read`, or by a guest upload's charge, when this month's R2 operation cap is reached (meter.ts). */
export class QuotaExhausted extends Error {}

/** A guest object's key: `g/` and 128 random bits. The key is the capability (DROP-09). */
export const newGuestKey = (): string => `g/${newRef()}`;

/** A guest file the check passed: what the ledger keeps and the Screen's item shows. */
export interface SettledFile {
  uploadId: string;
  fileId: string;
  r2Key: string;
  /** The validated type, never the name's. */
  kind: FileType;
  name: string;
  size: number;
  sha256: string;
}

export interface GuestDrop {
  /** Reserves budget for one session's file before R2 is asked: `storage_full` past the budget or the month's R2 operation caps, `already_uploaded` while the session's row is live. */
  reserve(sessionId: string, r2Key: string, bytes: number, name: string, type: FileType): Promise<DropError | null>;
  /** The file is ready: its ledger row takes the stored size, digest and validated type. False: the row was closed (the session ended). */
  settle(sessionId: string, file: SettledFile): Promise<boolean>;
  /** Counts `n` operations of a guest upload against the month's caps; false at the cap or when the count fails. */
  charge(cls: OpClass, n: number): Promise<boolean>;
  /** Throws `QuotaExhausted` when the month's class B cap is reached. */
  read(r2Key: string, range?: ByteRange): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  /** Idempotent. */
  delete(r2Key: string): Promise<void>;
  /** Deletes the session's object and ledger row: by its key when known, else by session. Returns whether an object existed. */
  purge(sessionId: string | null, r2Key: string | null): Promise<boolean>;
  /** Hourly backstop: deletes objects older than the given age. Returns the count. */
  sweep(olderThanMs: number): Promise<number>;
}

/** Pure checks over byte ranges (validate.ts). */
export interface RangeReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A read that came back shorter than asked: the object is gone or cut. `validate` refuses it as `bad_structure`. */
export class ShortRead extends Error {}

/**
 * Exactly `length` bytes at `offset`, else `ShortRead`. A validator reads only through this or the read plan
 * (read-plan.ts), so no check runs on fewer bytes than it asked for.
 */
export async function readExact(r: RangeReader, offset: number, length: number): Promise<Uint8Array> {
  const bytes = await r.read(offset, length);
  if (bytes.length !== length) throw new ShortRead();
  return bytes;
}

export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxCentralDirectoryBytes: 2 * 1024 * 1024,
  maxTotalUncompressed: 1024 * 1024 * 1024,
  maxEntryRatio: 200,
  /** The ratio rule applies from this size: tiny, repetitive parts legitimately pass 200:1. */
  ratioFloorBytes: 64 * 1024,
  /** The one entry inflated, to read its content types; never more than this. */
  maxContentTypesBytes: 256 * 1024,
  refusedParts: [/^ppt\/vbaProject\.bin$/i, /^ppt\/activeX\//i, /\.bin$/i],
  refusedContentTypes: [/macroEnabled/i, /vbaProject/i],
} as const;
