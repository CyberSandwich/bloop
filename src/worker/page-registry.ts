// Which pages the launch mode and a session gate (ADR 0026), and nothing else: no imports, so tools/live-check.mjs
// reads the same lists the Worker serves by (pages.ts).

/**
 * A page whose file differs by mode. `both`: the path exists in both modes with different files (the open one sits
 * under /open/ in the build output at the same relative path). `open-only`: 404 in preview. `preview-only`: 301 to `to`
 * in open. The site stream fills this list when it emits the open files; empty, no page differs and no mode is read.
 */
export interface Variant {
  path: string;
  kind: "both" | "open-only" | "preview-only";
  to?: string;
}
export const VARIANTS: readonly Variant[] = [];

/** Served and linked in open; in preview served unlinked and noindex, so test accounts reach them on the real host. */
export const AUTH_SHELLS: ReadonlySet<string> = new Set(["/signin", "/invite"]);
/** Need a session: in preview a signed-out request, or one the lockout refuses, gets the 404 any unknown path gets. */
export const MEMBER_PAGES: ReadonlySet<string> = new Set(["/library", "/account", "/admin"]);
