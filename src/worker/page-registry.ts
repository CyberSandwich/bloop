// Which pages the launch mode and a session gate (ADR 0026), and nothing else: no imports, so tools/live-check.mjs
// reads the same lists the Worker serves by (pages.ts). Frozen arrays, not Sets: freezing a Set leaves add() working.

/**
 * A page whose file differs by mode. `both`: the path exists in both modes with different files (the open one sits
 * under /open/ in the build output at the same relative path). `open-only`: 404 in preview. `preview-only`: 301 to `to`
 * in open.
 */
export interface Variant {
  readonly path: string;
  readonly kind: "both" | "open-only" | "preview-only";
  readonly to?: string;
}
// Every site page differs by mode, because the nav does. A unit test holds this list to the files the build emits
// under public/open/ (test/unit/pages-variants.test.ts); the open 404 page is not listed: `missing` serves it.
const BOTH = [
  "/",
  "/privacy",
  "/terms",
  "/security",
  "/accessibility",
  "/articles",
  "/articles/how-bloop-works",
  "/articles/threat-model-for-it-teams",
  "/articles/what-stays-on-the-pc",
  "/articles/data-and-retention",
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
];
export const VARIANTS: readonly Variant[] = Object.freeze([
  ...BOTH.map((path): Variant => ({ path, kind: "both" })),
  { path: "/articles/features", kind: "open-only" },
]);

/** Served and linked in open; in preview served unlinked and noindex, so test accounts reach them on the real host. */
export const AUTH_SHELLS: readonly string[] = Object.freeze(["/signin", "/invite"]);
/** Where a sign-in may land (ADR 0015): exact paths, `/admin` only for an admin; public/js/auth/row.js holds the same. */
export const SIGNIN_NEXT: readonly string[] = Object.freeze(["/library", "/a", "/account", "/admin"]);
export const signinNext = (next: string | null, admin: boolean): string =>
  next !== null && SIGNIN_NEXT.includes(next) && (next !== "/admin" || admin) ? next : "/library";

/** Need a session: in preview a signed-out request, or one the lockout refuses, gets the 404 any unknown path gets. */
export const MEMBER_PAGES: readonly string[] = Object.freeze(["/library", "/account", "/admin"]);
