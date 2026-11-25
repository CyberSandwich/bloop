// AuditLog seam (docs/interfaces.md section 7). The Screen object calls `record` at each transition;
// the D1 implementation is audit-d1.ts, picked in stores.ts.
import type { Actor, ErrorCode, Kind, Mode } from "../shared/protocol.ts";
import type { AuditType } from "./machine.ts";

/** Where a session sits, so the first event can create its `session` row. Never a secret, IP or token. */
export interface SessionContext {
  screenRef: string;
  roomId: string | null;
  mode: Mode;
  kind: Kind;
  userId: string | null;
}

/**
 * The `sessionId` of a row about an account, not a session (grant created or deleted). It lets `forUser` find
 * the row; erasure rewrites it to ERASED_SCOPE so nothing links back to the user.
 */
export const userScope = (userId: string): string => `user:${userId}`;
export const ERASED_SCOPE = "erased";

export interface AuditEvent {
  sessionId: string;
  at: number;
  actor: Actor;
  type: AuditType | "grant.created" | "grant.deleted" | "user.erased" | "export.run" | "pass.created";
  /** Allowed keys only. Never tokens, codes, URLs, IPs or Graph ids. */
  detail: {
    fileName?: string;
    source?: "mock" | "graph" | "guest";
    purpose?: string;
    cause?: ErrorCode;
    reason?: string;
    bytes?: number;
    ipMatch?: boolean;
    /** A /f/ request: its HTTP method, the class of client (never the raw User-Agent) and the fetch count. */
    method?: string;
    client?: "office" | "browser" | "other";
    count?: number;
    /** A session.length change: the new end, epoch ms. */
    endsAt?: number;
  };
  /** Present on the machine's events; later events find the row by `sessionId`. */
  session?: SessionContext;
}
/** An account event: a grant created or deleted, or an erasure (which keeps no link to the user). */
export function accountEvent(
  type: "grant.created" | "grant.deleted" | "user.erased",
  userId: string,
  at: number,
  actor: AuditEvent["actor"] = "phone",
): AuditEvent {
  return { sessionId: type === "user.erased" ? ERASED_SCOPE : userScope(userId), at, actor, type, detail: {} };
}

export interface AuditRow extends Omit<AuditEvent, "session"> {
  id: number;
  roomName: string | null;
  userEmail: string | null;
  /** Null for a row with no session (an export run). */
  mode: Mode | null;
  kind: Kind | null;
}

export interface AuditQuery {
  orgId: string | null;
  from: number;
  to: number;
  format: "csv" | "json";
}

export interface AuditLog {
  record(e: AuditEvent): Promise<void>;
  forUser(userId: string, limit: number, before?: number): Promise<AuditRow[]>;
  /** IT export of `[from, to)`. CSV cells starting with = + - @ tab or CR get a leading apostrophe. */
  export(q: AuditQuery): Promise<ReadableStream<Uint8Array>>;
  purge(now: number, retention: { liveDays: number; demoDays: number }): Promise<number>;
  /** Erasure: keeps session, room and time; drops user id and file name. */
  anonymizeUser(userId: string): Promise<number>;
}

/** The detail keys a row may hold. Anything else is dropped before the write, so a caller cannot leak by mistake. */
export const DETAIL_KEYS = [
  "fileName",
  "source",
  "purpose",
  "cause",
  "reason",
  "bytes",
  "ipMatch",
  "method",
  "client",
  "count",
  "endsAt",
] as const;

export function sanitizeDetail(detail: AuditEvent["detail"]): AuditEvent["detail"] {
  const src = detail as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as AuditEvent["detail"];
}
