// What a session end asks of the live layer (plan A section 1, L's contract). The whole-account end goes through
// live-screens.ts, L's seam; ending one session's screens or a file's screens, and closing a session's library
// sockets, do nothing until L lands.
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

/** Closes the library sockets of a session that ended. */
export async function closeSession(_env: Env, _publicId: string): Promise<void> {}

/** The live-layer calls a route makes, injected so a test can watch them. */
export interface ScreenDeps {
  endScreens: typeof endScreens;
  closeSession: typeof closeSession;
}

export const screenDeps: ScreenDeps = { endScreens, closeSession };
