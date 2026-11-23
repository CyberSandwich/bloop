// The phone's file list and the approve that names one of its entries. The Worker resolves the file
// from the source itself: the client sends an id and nothing else about the file (SRC-01).
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { fail, json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { type Access, accessFor, LIST_LIMIT, resolveListed } from "../source-access.ts";
import { respond, screenFor, withConfig, write } from "./common.ts";

const approveBody = z.object({ fileId: z.string().min(1).max(256) }).strict();

type Phone = {
  ok: true;
  screen: NonNullable<ReturnType<typeof screenFor>>;
  access: Extract<Access, { ok: true }>;
};

/** A paired owner phone and the source that serves it, or the response to send instead. */
async function phoneAccess(
  request: Request,
  env: Env,
  config: Config,
): Promise<Phone | { ok: false; response: Response }> {
  const screen = screenFor(request, env);
  if (!screen) return { ok: false, response: fail("unauthorized") };
  const view = await screen.stub.phoneView(screen.credential);
  if (!view.ok) return { ok: false, response: fail(view.error) };
  // Guests have no account to list; their file arrives through the drop.
  if (view.value.kind !== "owner") return { ok: false, response: fail("wrong_state") };
  const access = await accessFor(request, env, config, view.value.mode);
  return access.ok ? { ok: true, screen, access } : access;
}

export const fileRoutes: readonly Route[] = [
  route(
    ["GET"],
    "/api/files",
    "api",
    withConfig(async (request, env, config) => {
      const phone = await phoneAccess(request, env, config);
      if (!phone.ok) return phone.response;
      const listed = await phone.access.source.listRecent(phone.access.ctx, LIST_LIMIT);
      if (!listed.ok) return fail(listed.error);
      // The Screen object keeps the ids it was shown: approve in a live session accepts only those.
      const told = await phone.screen.stub.listed(
        phone.screen.credential,
        listed.files.map((f) => f.id),
      );
      return told.ok ? json({ files: listed.files }) : fail(told.error);
    }),
  ),

  route(
    ["POST"],
    "/api/approve",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, approveBody);
      if (!body.ok) return body.response;
      const phone = await phoneAccess(request, env, config);
      if (!phone.ok) return phone.response;
      const file = await resolveListed(phone.access, body.value.fileId);
      if (!file.ok) return fail(file.error);
      return respond(
        await phone.screen.stub.approve(phone.screen.credential, body.value.fileId, file.file, phone.access.ctx.userId),
      );
    }),
  ),
];
