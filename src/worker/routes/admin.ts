// Admin routes (/api/admin/*). Each is Admin-only (ADR 0014): a member or a signed-out request gets `not_found`, so
// the admin surface looks like a missing path, and the mode is read fresh.
import { z } from "zod";
import { clearCookie, setCookie, VIEW_COOKIE, VIEW_MAX_AGE_SECONDS, withCookies } from "../auth/cookies.ts";
import { json } from "../http.ts";
import type { Route } from "../router.ts";
import { memberRoute } from "./account.ts";

const ADMIN = { admin: true, limit: "RL_ADMIN", fresh: true } as const;

export const adminRoutes: readonly Route[] = [
  // The /admin preview toggle (ADR 0026): the view cookie on or off. It shows the open site to this admin alone, and
  // pages.ts checks the admin session on every request, so the cookie alone shows nothing.
  memberRoute(
    ["POST"],
    "/api/admin/view",
    { ...ADMIN, body: z.object({ open: z.boolean() }).strict() },
    async ({ body }) => {
      const cookie = body.open ? setCookie(VIEW_COOKIE, "open", VIEW_MAX_AGE_SECONDS) : clearCookie(VIEW_COOKIE);
      return withCookies(json({ viewing: body.open }), [cookie]);
    },
  ),
];
