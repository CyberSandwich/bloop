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
  };
  /** Present on the machine's events; later events find the row by `sessionId`. */
  session?: SessionContext;
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
] as const;

export function sanitizeDetail(detail: AuditEvent["detail"]): AuditEvent["detail"] {
  const src = detail as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as AuditEvent["detail"];
}
