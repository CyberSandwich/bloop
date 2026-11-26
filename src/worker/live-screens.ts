// Ending a member's live screens: a deletion request, a sign-out everywhere, a suspension and the purge all call
// `endLiveScreens`. The user's object keeps the rows (who approved what, on which screen); each Screen object ends its
// own session through `Screen.endFromOwner`, which ends it only when the pairing's user is the one named, and answers
// ok when nothing live is left for that user, so a not-ok is a real failure and the caller retries it.
import type { Env } from "./env.ts";
import { userLibraryStub } from "./stubs.ts";

/** Every live screen of the member, or only those a session started (`bySession`, its public id) or showing a file. */
export async function endLiveScreens(
  env: Env,
  userId: string,
  filter: { bySession?: string; fileId?: string } = {},
): Promise<void> {
  await userLibraryStub(env, userId).endScreens(userId, filter);
}
