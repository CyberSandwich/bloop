// The phone's list and the approve that names some of its entries. The Worker resolves the items from the source
// itself: the client sends ids and nothing else about them (SRC-01, SRC-02).
import { z } from "zod";
import type { Mode } from "../../shared/protocol.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { fail, json } from "../http.ts";
import { MAX_ITEMS } from "../items.ts";
import { type Route, route } from "../router.ts";
import { type Access, accessFor, listEntries, resolveListed } from "../source-access.ts";
import { limited, respond, screenFor, withConfig, write } from "./common.ts";

// Distinct ids, checked here so a repeat costs no source listing before the machine would refuse it.
const approveBody = z
  .object({
    ids: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(MAX_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

type Phone = {
  ok: true;
  screen: NonNullable<ReturnType<typeof screenFor>>;
  access: Extract<Access, { ok: true }>;
  mode: Mode;
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
  return access.ok ? { ok: true, screen, access, mode: view.value.mode } : access;
}

export const fileRoutes: readonly Route[] = [
  route(
    ["GET"],
    "/api/files",
    "api",
    withConfig(async (request, env, config) => {
      const phone = await phoneAccess(request, env, config);
      if (!phone.ok) return phone.response;
      // Each listing is a Graph call: limited per session, after the credential check so a stranger cannot spend it.
      const tooMany = await limited(env.RL_FILES, request, config, phone.screen.ref);
      if (tooMany) return tooMany;
      const listed = await listEntries(phone.access);
      if (!listed.ok) return fail(listed.error);
      // The Screen object keeps the ids it was shown: approve in a live session accepts only those.
      const told = await phone.screen.stub.listed(
        phone.screen.credential,
        listed.entries.map((e) => e.id),
      );
      return told.ok ? json({ items: listed.entries }) : fail(told.error);
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
      // A live screen shows one file: more ids cost no listing before the machine (the authority) would refuse them.
      if (phone.mode === "live" && body.value.ids.length !== 1) return fail("bad_request");
      const resolved = await resolveListed(phone.access, body.value.ids);
      if (!resolved.ok) return fail(resolved.error);
      return respond(await phone.screen.stub.approve(phone.screen.credential, resolved.items, phone.access.ctx.userId));
    }),
  ),
];
