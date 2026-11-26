// What a session end asks of the live layer, the library's UserLibrary object (ADR 0015). The whole-account screen end
// goes through live-screens.ts, the library's seam.
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
  await endLiveScreens(env, userId, scope);
}

/** The slice of the library's UserLibrary a session end calls: it closes the sockets tagged `s:<publicId>`. */
interface LibrarySessions {
  closeSessions(publicIds: string[]): Promise<void>;
}

type LibraryEnv = Pick<Env, "USER_LIBRARY" | "PUBLIC_ORIGIN">;

/** False would leave every object asleep (each wake is billed) and log nothing; it is on now that closeSessions exists. */
export const LIBRARY_CLOSES_SESSIONS = true;

/**
 * Closes the library sockets of ended sessions in one call on the member's UserLibrary (idFromName(userId), eu).
 * Best effort: the D1 rows are already gone, so a socket left open fails its next cookie check.
 */
export const librarySessions =
  (enabled: boolean) =>
  async (env: LibraryEnv, userId: string, publicIds: readonly string[]): Promise<void> => {
    if (!enabled || publicIds.length === 0) return;
    try {
      const ns = isLocalOrigin(env.PUBLIC_ORIGIN) ? env.USER_LIBRARY : env.USER_LIBRARY.jurisdiction("eu");
      const stub = ns.get(ns.idFromName(userId)) as unknown as LibrarySessions;
      await stub.closeSessions([...publicIds]);
    } catch {
      console.log(JSON.stringify({ evt: "library", kind: "close_sessions_failed" }));
    }
  };

export const closeSessions = librarySessions(LIBRARY_CLOSES_SESSIONS);

/** The live-layer calls a route makes, injected so a test can watch them. */
export interface ScreenDeps {
  endScreens: typeof endScreens;
  closeSessions: typeof closeSessions;
}

export const screenDeps: ScreenDeps = { endScreens, closeSessions };

/** Every session end: the screens the ended sessions started (or all of the member's), then their library sockets. */
export async function endSessions(
  deps: ScreenDeps,
  env: Env,
  userId: string,
  publicIds: readonly string[],
  scope: ScreenScope = {},
): Promise<void> {
  await deps.endScreens(env, userId, scope);
  await deps.closeSessions(env, userId, publicIds);
}
