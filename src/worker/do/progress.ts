// A guest upload's progress for the room screen (`Screen.uploadProgress`): at most one frame a second per upload, and
// never backward. Pure, so the throttle is tested without a Durable Object.

/** The fewest milliseconds between two frames of one upload. */
export const PROGRESS_EVERY_MS = 1000;
/** Uploads remembered at once; a session holds at most a few open, so past this the oldest is forgotten. */
const KEPT = 16;

export interface Sent {
  at: number;
  fraction: number;
}

/**
 * Whether a report goes out now, and records it when it does. A fraction outside 0 to 1 or not a number is refused
 * (null); a lower or equal one, or one within the second, is dropped (false).
 */
export function admitProgress(
  sent: Map<string, Sent>,
  uploadId: string,
  fraction: number,
  now: number,
): boolean | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 || uploadId === "") return null;
  const last = sent.get(uploadId);
  if (last && (fraction <= last.fraction || now - last.at < PROGRESS_EVERY_MS)) return false;
  sent.delete(uploadId);
  if (sent.size >= KEPT) sent.delete(sent.keys().next().value as string);
  sent.set(uploadId, { at: now, fraction });
  return true;
}
