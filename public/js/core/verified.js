// Open items of docs/design.md section 15 whose claims may reach a screen. A false flag drops the
// string that depends on it and the page shows the fallback written there.
export const VERIFIED = {
  /** V-2: the session ends by itself (machine alarm, SESSION_MAX_MINUTES). */
  autoEnd: true,
  /** V-4: the screen view carries a session id and a file name, never an account. */
  accountNeverReaches: true,
  /** V-7: the room view says whether the screen is registered. */
  roomRegistration: true,
  /** V-1: what the PC still holds after End is measured per room. */
  endedLink: false,
  /** V-9: phone account needs (connect once, consent, sign-in lifetime). */
  oneDriveOnce: false,
  /** V-5: bloop deletes a guest upload when the session ends (seams/guest-drop/purge.ts; DROP-07 tests). */
  guestDelete: true,
};
