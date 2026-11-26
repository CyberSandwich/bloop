// What a session end asks of the live layer (plan A section 1, L's contract). The whole-account end goes through
// live-screens.ts, L's seam; ending one session's screens or a file's screens do nothing until L lands.
import { isLocalOrigin } from "../config.ts";
import type { Env } from "../env.ts";
import { endLiveScreens } from "../live-screens.ts";

export interface ScreenScope {
  /** Only the screens this session (its public id) started. */
  bySession?: string;
  /** Only the screens showing this file. */
  fileId?: string;
}

/** Ends the member's live screens: all of them, or the scope named. */
export async function endScreens(env: Env, userId: string, scope: ScreenScope = {}): Promise<void> {
  if (scope.bySession === undefined && scope.fileId === undefined) await endLiveScreens(env, userId);
}

/** The slice of L's UserLibrary (plan-l 3.2) a session end calls: it closes the sockets tagged `s:<publicId>`. */
interface LibrarySessions {
  closeSession(publicId: string): Promise<void>;
}

/**
 * Closes the library sockets of a session that ended, on the member's UserLibrary (idFromName(userId), eu). Best
 * effort: the D1 row is already gone, so a socket that stays open fails its next cookie check and closes at 12 h.
 * Replace the namespace lookup with stubs.ts `userLibraryStub` once L adds it.
 */
export async function closeSession(
  env: Pick<Env, "USER_LIBRARY" | "PUBLIC_ORIGIN">,
  userId: string,
  publicId: string,
): Promise<void> {
  const ns = isLocalOrigin(env.PUBLIC_ORIGIN) ? env.USER_LIBRARY : env.USER_LIBRARY.jurisdiction("eu");
  const stub = ns.get(ns.idFromName(userId)) as unknown as LibrarySessions;
  try {
    await stub.closeSession(publicId);
  } catch {
    console.log(JSON.stringify({ evt: "library", kind: "close_session_failed" }));
  }
}

/** The live-layer calls a route makes, injected so a test can watch them. */
export interface ScreenDeps {
  endScreens: typeof endScreens;
  closeSession: typeof closeSession;
}

export const screenDeps: ScreenDeps = { endScreens, closeSession };
