// /invite's own strings (docs/ux/signin.md section 5); the shared ones are in copy.js.
export const INVITE = {
  title: "You're Invited",
  to: "Early access to bloop for {masked}.",
  about: "bloop puts your files on the room screen from your phone. The screen never gets your account.",
  until: "The invite works until {date}.",
  accept: "Accept Invite",
  adult: "By continuing you confirm you are 18 or over and accept the Terms.",
  signedInAs: "You're Signed In as {masked}",
  forOther: "This invite is for {masked}.",
  signOut: "Sign Out and Continue",
  library: "Go to Your Library",
  home: "Go to the Home Page",
  signIn: "Sign In",
  retry: "Try Again",
  /** The peek states and the load failures, each a dead end with at most one exit (docs/ux/signin.md section 5). */
  dead: {
    expired: { title: "This Invite Has Expired", line: "Ask the person who invited you for a new one.", exit: "home" },
    used: { title: "This Invite Was Already Used", line: "Sign in with the email it went to.", exit: "signin" },
    invalid: { title: "This Invite Isn't Valid", line: "Check you opened the newest invite email.", exit: "home" },
    none: { title: "Open Your Invite Email", line: "Tap the link in the email to accept.", exit: "home" },
    limited: { title: "Too Many Tries Right Now", line: "Wait a minute, then open the link again.", exit: null },
    offline: { title: "You're Offline", line: "Check your connection, then try again.", exit: "retry" },
    down: { title: "bloop Isn't Responding", line: "Try again in a minute.", exit: "retry" },
  },
};
