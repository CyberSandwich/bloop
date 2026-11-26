// The open site's account pill in both states: the one source for the build (tools/build-pages.mjs writes
// ACCOUNT_PILL_OUT into every open page) and the Worker (src/worker/nav-pill.ts swaps it for ACCOUNT_PILL_IN).
// Both labels share one grid cell, so the pill is as wide as the wider one in either state.
export const ACCOUNT_PILL_OUT =
  '<a class="btn account" href="/signin" data-account><span>Sign In</span><span aria-hidden="true">Library</span></a>';
export const ACCOUNT_PILL_IN =
  '<a class="btn account" href="/library" data-account><span aria-hidden="true">Sign In</span><span>Library</span></a>';
