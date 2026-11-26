// Imported first by /a so it runs before anything else on the page: it takes the pairing code out of
// the address bar (architecture.md section 4.1), so it never lingers in history or a screenshot.
import { codeFromSearch } from "./format.js";

export const bootCode = codeFromSearch(location.search);
if (location.search) history.replaceState(null, "", location.pathname);

/** The sessionStorage key of a code kept across sign-in (core/early.js), the other way a code reaches /a. */
export const KEPT = "bloop.resume";
