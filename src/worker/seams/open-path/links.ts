// The /f/ link: its shape, its life rules and the request classification. Pure apart from the random
// draw and the hash, so unit tests cover every rule without a Worker (ADR 0003, threat model OPEN-01).
import { linkFileName, MAX_BASE } from "../../../../public/js/shared/names.js";
import type { OpenError, OpenMode } from "../../../shared/protocol.ts";
import type { LinkConfig } from "../../config.ts";
import { base64url, randomBytes, safeEqual, sha256Hex } from "../../ids.ts";
import { effectivePurpose } from "../../items.ts";
import type { FileRef } from "../../machine.ts";

/** screenRef (22) plus this many base64url characters of secret: 192 bits. */
const SECRET_CHARS = 32;
const TOKEN = /^([A-Za-z0-9_-]{22})([A-Za-z0-9_-]{32})$/;
/** A link is at most this long; the Office URI adds 20 and stays far under its 256 cap. */
export const MAX_LINK_CHARS = 200;
const PROTOCOL_PREFIX = "ms-powerpoint:ofv|u|";

export interface MintedLink {
  /** screenRef plus secret. Only its SHA-256 is stored. */
  token: string;
  tokenHash: string;
  purpose: OpenMode;
  url: string;
}

/** What a Screen object keeps per link. No token, no URL. */
export interface LinkRecord {
  tokenHash: string;
  purpose: OpenMode;
  /** Index into the session's items: the file this link serves. */
  item: number;
  mintedAt: number;
  firstFetchAt: number | null;
  fetches: number;
  revoked: boolean;
}

/** The longest name segment that keeps the whole link inside MAX_LINK_CHARS for this origin. */
export function nameBudget(origin: string, extLength: number): number {
  const fixed = `${origin}/f//`.length + SECRET_CHARS + 22 + 1 + extLength;
  return Math.max(1, Math.min(MAX_BASE, MAX_LINK_CHARS - fixed));
}

/** Mints a link for `file` (see `effectivePurpose`). A deck's PDF link serves the rendition, so its name ends in .pdf too. */
export async function mintLink(
  screenRef: string,
  file: FileRef,
  purpose: OpenMode,
  origin: string,
): Promise<MintedLink> {
  const effective = effectivePurpose(file.type, purpose);
  const ext = effective === "pdf" ? "pdf" : file.type;
  const token = `${screenRef}${base64url(randomBytes((SECRET_CHARS * 3) / 4))}`;
  const url = `${origin}/f/${token}/${linkFileName(file.name, ext, nameBudget(origin, ext.length))}`;
  if (url.length > MAX_LINK_CHARS) throw new Error("link too long for this origin");
  return { token, tokenHash: await sha256Hex(token), purpose: effective, url };
}

/** `ms-powerpoint:ofv|u|<url>`: opens read-only. The URI as a whole stays under Office's 256 characters. */
export const protocolUri = (url: string): string => `${PROTOCOL_PREFIX}${url}`;

/** The route's view of a token: the Screen object it addresses, or null for anything not shaped like one. */
export function parseToken(token: string): { screenRef: string } | null {
  const m = TOKEN.exec(token);
  return m ? { screenRef: m[1] as string } : null;
}

/** The record a hash names, compared without an early exit. */
export function findLink(records: readonly LinkRecord[], tokenHash: string): LinkRecord | null {
  return records.find((r) => safeEqual(r.tokenHash, tokenHash)) ?? null;
}

/** Why a link cannot be used at `now`, or null. The caller has already checked the session is live. */
export function refusal(rec: LinkRecord, now: number, limits: LinkConfig): OpenError | null {
  if (rec.revoked) return "link_revoked";
  if (rec.fetches >= limits.maxFetches) return "link_exhausted";
  const dies =
    rec.firstFetchAt === null
      ? rec.mintedAt + limits.firstFetchSeconds * 1000
      : rec.firstFetchAt + limits.fetchWindowSeconds * 1000;
  return now >= dies ? "link_expired" : null;
}

export type ClientClass = "office" | "browser" | "other";

/** A coarse class of the requesting client for the audit log. The raw User-Agent is never stored. */
export function clientClass(userAgent: string | null): ClientClass {
  const ua = userAgent ?? "";
  if (/ms-?office|microsoft office|powerpoint|office\//i.test(ua)) return "office";
  return /^Mozilla\/5\.0/.test(ua) ? "browser" : "other";
}
