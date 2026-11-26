// The Worker-side dependencies the library jobs take as arguments, built from the environment. Kept apart so the modules
// tests import never reach the Durable Object stubs.
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { launchState } from "../mode.ts";
import { userLibraryStub } from "../stubs.ts";
import type { PurgeDeps } from "./purge.ts";
import type { RetentionDeps } from "./retention.ts";

export const purgeDepsFor = (env: Pick<Env, "USER_LIBRARY" | "PUBLIC_ORIGIN">): PurgeDeps => ({
  // transitional: V2: the Converter's stop replaces this no-op
  cancelConversion: async () => {},
  exporting: (userId) => userLibraryStub(env, userId).exportActive(),
  now: Date.now,
});

/**
 * The cron's dependencies. `warn` answers false until A's inactivity email exists, so no inactivity deletion can start
 * without a sent warning.
 */
export async function retentionDepsFor(env: Env, config: Config): Promise<RetentionDeps> {
  const state = await launchState(env);
  const everyone = [...config.account.adminEmails, ...config.account.testEmails];
  return {
    ...purgeDepsFor(env),
    endScreens: async (userId) => void (await userLibraryStub(env, userId).endScreens(userId)),
    closeSessions: (userId, publicIds) => userLibraryStub(env, userId).closeSessions(publicIds),
    // transitional: U: abortAllFor replaces this
    abortUploads: async () => false,
    eraseObject: (userId) => userLibraryStub(env, userId).purge(),
    // transitional: A: the inactivity email replaces this
    warn: async () => false,
    lockoutMembers: state.lockout ? everyone : null,
  };
}
