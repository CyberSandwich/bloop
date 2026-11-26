// The Worker-side dependencies the library jobs take as arguments, built from the environment. Kept apart so the modules
// tests import never reach the Durable Object stubs.
import type { Env } from "../env.ts";
import { userLibraryStub } from "../stubs.ts";
import type { PurgeDeps } from "./purge.ts";

/** V2 replaces `cancelConversion` with its Converter's stop when it lands. */
export const purgeDepsFor = (env: Pick<Env, "USER_LIBRARY" | "PUBLIC_ORIGIN">): PurgeDeps => ({
  cancelConversion: async () => {},
  exporting: (userId) => userLibraryStub(env, userId).exportActive(),
  now: Date.now,
});
