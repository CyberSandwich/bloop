// Ending a member's live screens: a deletion request, a sign-out everywhere, a suspension and the purge all call
// `endLiveScreens`. The user's object keeps the rows (who approved what, on which screen); each Screen object ends its
// own session through `endFromOwner`, which ends it only when the pairing's user is the one named.
import type { Env } from "./env.ts";
import type { Result } from "./seams/pairing.ts";
import { screenStub, userLibraryStub } from "./stubs.ts";

/** What a Screen object offers the user's object: end the live session if it belongs to `userId`. */
export interface OwnerEnd {
  endFromOwner(userId: string): Promise<Result<null>>;
}

/** The Screen behind `screenRef`, as far as ending it from its owner goes. */
// transitional: P1: commit 4 gives Screen `endFromOwner`; this cast and `OwnerEnd` go, and the stub is typed by Screen
export const screenOwnerEnd = (env: Env, screenRef: string): OwnerEnd =>
  screenStub(env, screenRef) as unknown as OwnerEnd;

export async function endLiveScreens(env: Env, userId: string): Promise<void> {
  await userLibraryStub(env, userId).endScreens(userId);
}
