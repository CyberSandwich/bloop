// Every user-facing string of /s, /a and /code (docs/design.md sections 3 and 7): headings in Title Case with no
// period, lines as sentences. A string marked [V-n] there is gated by verified.js. Each page loads only its own file
// (copy-screen.js, copy-phone.js, copy-code.js); a string two pages show lives here.

/** The one string that names the session (design.md section 3). */
export const SESSION_ENDED = "Session Ended";
export const TYPED_WRONG = "Check the code on the screen.";
/** The waitlist form, as content/site.json names it (a unit test holds them equal); each link adds its ?source=. */
export const WAITLIST_FORM = "https://tally.so/r/Yj4KAN";
