// Admin routes (/api/admin/*). Each is Admin-only (ADR 0014): a member or a signed-out request gets `not_found`, so
// the admin surface looks like a missing path, and the mode is read fresh. Every admin action writes its
// `admin_action` row (ADR 0013).
import { z } from "zod";
import { clearCookie, setCookie, VIEW_COOKIE, VIEW_MAX_AGE_SECONDS, withCookies } from "../auth/cookies.ts";
import { dbOf } from "../auth/db.ts";
import { stripControls } from "../auth/templates.ts";
import { json } from "../http.ts";
import type { Route } from "../router.ts";
import { memberRoute } from "./account.ts";

const ADMIN = { admin: true, limit: "RL_ADMIN", fresh: true } as const;

/** Why the admin acted, as every admin write records it: control and format characters go first (`stripControls`). */
const reason = z.string().transform(stripControls).pipe(z.string().trim().min(1).max(500));

const viewBody = z.object({ open: z.boolean(), reason }).strict();

export const adminRoutes: readonly Route[] = [
  // The /admin preview toggle (ADR 0026): the view cookie on or off, logged against the admin's own user row. It shows
  // the open site to this admin alone, and pages.ts checks the admin session on every request, so the cookie alone
  // shows nothing. The row is written before the cookie is set: an unlogged preview never starts.
  memberRoute(["POST"], "/api/admin/view", { ...ADMIN, body: viewBody }, async ({ env, member, body }) => {
    await dbOf(env.DB)
      .prepare(
        "INSERT INTO admin_action (at, admin_user_id, action, target_kind, target_id, reason) VALUES (?, ?, ?, 'user', ?, ?)",
      )
      .bind(Date.now(), member.userId, body.open ? "view.open" : "view.close", member.userId, body.reason)
      .run();
    const cookie = body.open ? setCookie(VIEW_COOKIE, "open", VIEW_MAX_AGE_SECONDS) : clearCookie(VIEW_COOKIE);
    return withCookies(json({ viewing: body.open }), [cookie]);
  }),
];
