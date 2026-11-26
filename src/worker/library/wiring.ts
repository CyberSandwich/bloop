// The Worker-side dependencies the library jobs take as arguments, built from the environment. Kept apart so the modules
// tests import never reach the Durable Object stubs.
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { launchState } from "../mode.ts";
import { userLibraryStub } from "../stubs.ts";
import type { PurgeDeps } from "./purge.ts";
import type { RetentionDeps } from "./retention.ts";

/** V2 replaces `cancelConversion` with its Converter's stop when it lands. */
export const purgeDepsFor = (env: Pick<Env, "USER_LIBRARY" | "PUBLIC_ORIGIN">): PurgeDeps => ({
  cancelConversion: async () => {},
  exporting: (userId) => userLibraryStub(env, userId).exportActive(),
  now: Date.now,
});

/**
 * The cron's dependencies. Two are placeholders until their owners land: `abortUploads` (U's abortAllFor) and `warn`
 * (A's inactivity template). `warn` answers false, so no inactivity deletion can start without a sent warning.
 */
export async function retentionDepsFor(env: Env, config: Config): Promise<RetentionDeps> {
  const state = await launchState(env);
  const everyone = [...config.account.adminEmails, ...config.account.testEmails];
  return {
    ...purgeDepsFor(env),
    endScreens: (userId) => userLibraryStub(env, userId).endScreens(userId),
    closeSessions: async (userId, publicIds) => {
      const stub = userLibraryStub(env, userId);
      for (const id of publicIds) await stub.closeSession(id);
    },
    abortUploads: async () => false,
    eraseObject: (userId) => userLibraryStub(env, userId).purge(),
    warn: async () => false,
    lockoutMembers: state.lockout ? everyone : null,
  };
}
