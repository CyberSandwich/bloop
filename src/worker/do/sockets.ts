/** At most this many sockets may wait for their `hello` at once; the next upgrade is refused (`rate_limited`). */
export const MAX_PENDING_SOCKETS = 4;

type Attachments = readonly ({ authed: boolean } | null)[];

/** Only a socket that sent a verified `hello` counts toward keeping a screen open: a bare upgrade proves nothing. */
export const countAuthed = (attachments: Attachments): number => attachments.filter((a) => a?.authed).length;

export const countPending = (attachments: Attachments): number => attachments.length - countAuthed(attachments);
