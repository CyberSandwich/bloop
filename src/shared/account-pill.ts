// The open site's account pill in both states: the one source for the build (tools/build-pages.mjs writes
// ACCOUNT_PILL_OUT into every open page) and the Worker (src/worker/nav-pill.ts swaps it for ACCOUNT_PILL_IN).
// The CSS gives the pill one min-width wider than either label, so the swap never moves the pair.
export const ACCOUNT_PILL_OUT = '<a class="btn account" href="/signin" data-account>Sign In</a>';
export const ACCOUNT_PILL_IN = '<a class="btn account" href="/library" data-account>Library</a>';
