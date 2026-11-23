// AuditLog seam (docs/interfaces.md section 7). The Screen object calls `record` at each transition.
import type { Actor, ErrorCode, Kind, Mode } from "../shared/protocol.ts";
import type { AuditType } from "./machine.ts";

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
  };
}
export interface AuditRow extends AuditEvent {
  id: number;
  roomName: string | null;
  userEmail: string | null;
  mode: Mode;
  kind: Kind;
}

export interface AuditLog {
  record(e: AuditEvent): Promise<void>;
  forUser(userId: string, limit: number, before?: number): Promise<AuditRow[]>;
  /** IT export. CSV cells starting with = + - @ tab or CR get a leading apostrophe. */
  export(q: {
    orgId: string | null;
    from: number;
    to: number;
    format: "csv" | "json";
  }): Promise<ReadableStream<Uint8Array>>;
  purge(now: number, retention: { liveDays: number; demoDays: number }): Promise<number>;
  /** Erasure: keeps session, room and time; drops user id and file name. */
  anonymizeUser(userId: string): Promise<number>;
}

/** Stub: keeps nothing. The D1 implementation replaces it in stores.ts. */
export const noopAudit: AuditLog = {
  async record() {},
  async forUser() {
    return [];
  },
  async export() {
    return new ReadableStream({ start: (c) => c.close() });
  },
  async purge() {
    return 0;
  },
  async anonymizeUser() {
    return 0;
  },
};
