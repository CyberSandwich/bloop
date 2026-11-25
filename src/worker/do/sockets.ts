/** Sockets waiting for their `hello`, per role; the next upgrade is refused (`rate_limited`). */
export const MAX_PENDING_SOCKETS = 4;
/** Of those, one address hash may hold this many per role, so one client cannot lock the others out. */
export const MAX_PENDING_PER_IP = 2;

interface Held {
  authed: boolean;
  role: string;
  ip: string;
}
type Attachments = readonly (Held | null)[];

/** Only a socket that sent a verified `hello` counts toward keeping a screen open: a bare upgrade proves nothing. */
export const countAuthed = (attachments: readonly ({ authed: boolean } | null)[]): number =>
  attachments.filter((a) => a?.authed).length;

/** Whether one more socket of `role` from `ip` may wait for its `hello`. */
export function mayWait(attachments: Attachments, role: string, ip: string): boolean {
  const pending = attachments.filter((a): a is Held => a !== null && !a.authed && a.role === role);
  return pending.length < MAX_PENDING_SOCKETS && pending.filter((a) => a.ip === ip).length < MAX_PENDING_PER_IP;
}
