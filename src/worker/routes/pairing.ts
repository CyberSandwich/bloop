// Pairing routes (architecture section 6). Each handler: config, then the CSRF checks for writes
// (PAIR-06), then the platform rate limit, then Zod on the body, then one call into a Durable Object.
import { z } from "zod";
import { normalize } from "../../../public/js/shared/codes.js";
import { phoneUser, servicesFor } from "../auth/services.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, fail, json } from "../http.ts";
import { newRef } from "../ids.ts";
import { type Route, route } from "../router.ts";
import { directoryStub, screenStub } from "../stubs.ts";
import { ipHash, limited, netHash, respond, withConfig, withScreen, write } from "./common.ts";

const mode = z.enum(["live", "demo"]);
const createBody = z.object({ mode }).strict();
const claimBody = z
  .object({
    code: z.string().max(32),
    kind: z.enum(["owner", "guest"]).optional(),
  })
  .strict();
const emptyBody = z.object({}).strict();

const REF = /^[A-Za-z0-9_-]{22}$/;

/**
 * WebSocket upgrade: the Origin must be ours; the credential is the first frame, so the URL carries only the ref.
 * `RL_UPGRADE`, its own binding so reconnects never spend a tap's, is spent per screen and network (an IPv6 /64, as
 * the Screen object's pending cap counts) before the Screen object is reached (PAIR-10).
 */
async function upgrade(request: Request, env: Env, config: Config): Promise<Response> {
  const refused = checkOrigin(request, config.origin);
  if (refused) return refused;
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail("bad_request");
  const ref = new URL(request.url).searchParams.get("ref") ?? "";
  if (!REF.test(ref)) return fail("bad_request");
  const tooMany = await limited(env, "RL_UPGRADE", request, config, `${ref}.${await netHash(request, config)}`);
  if (tooMany) return tooMany;
  return screenStub(env, ref).fetch(request);
}

export const pairingRoutes: readonly Route[] = [
  route(
    ["POST"],
    "/api/screens",
    "api",
    // transitional: removed in P1 commit 4 (the Idempotency-Key replay, REL-14)
    withConfig(async (request, env, config) => {
      const body = await write(request, config, createBody);
      if (!body.ok) return body.response;
      const demo = body.value.mode === "demo";
      if (demo && !config.demoEnabled) return fail("not_found");
      const tooMany = await limited(env, demo ? "RL_DEMO_CREATE" : "RL_CREATE", request, config);
      if (tooMany) return tooMany;
      const screenRef = newRef();
      // The cap is the last check, so a refused create leaves nothing behind.
      if (demo) {
        const { demoHoldMs, demoMaxConcurrent, demoMaxPerIp } = config;
        const held = await directoryStub(env).demoReserve(
          screenRef,
          await ipHash(request, config),
          demoHoldMs,
          demoMaxConcurrent,
          demoMaxPerIp,
        );
        if (!held) return fail("rate_limited");
      }
      const created = await screenStub(env, screenRef).create({
        screenRef,
        mode: body.value.mode,
        roomId: null,
        roomName: null,
      });
      return respond(created, 201);
    }),
  ),

  route(["GET"], "/api/screen/ws", "api", withConfig(upgrade)),

  route(
    ["GET"],
    "/api/screen/state",
    "api",
    withConfig(async (request, env, config) => {
      const ip = await ipHash(request, config);
      return withScreen(
        request,
        env,
        (stub, sid) => stub.screenView(sid, ip),
        (view) => json(view),
      );
    }),
  ),

  route(
    ["POST"],
    "/api/screen/restart",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, emptyBody);
      if (!body.ok) return body.response;
      return withScreen(
        request,
        env,
        (stub, sid) => stub.restart(sid),
        (view) => json(view),
      );
    }),
  ),

  route(
    ["POST"],
    "/api/screen/end",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, emptyBody);
      if (!body.ok) return body.response;
      return withScreen(
        request,
        env,
        (stub, sid) => stub.endFromScreen(sid),
        // Clears the lectern browser's storage even if the page script was tampered with (RES-01).
        (view) => json(view, 200, { "Clear-Site-Data": '"storage"' }),
      );
    }),
  ),

  route(
    ["POST"],
    "/api/claim",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, claimBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env, "RL_CLAIM", request, config);
      if (tooMany) return tooMany;
      const code = normalize(body.value.code);
      if (!code) return fail("code_malformed");
      const hashed = await ipHash(request, config);
      const found = await directoryStub(env).lookup(code, hashed, Date.now());
      if (!found.ok) return fail(found.error);
      if (found.demo) {
        if (!config.demoEnabled) return fail("not_found");
        const slow = await limited(env, "RL_DEMO_CLAIM", request, config);
        if (slow) return slow;
      }
      // transitional: removed in P1 commit 4 (auth-first PAIR-15, the Idempotency-Key replay, the phoneSession pin)
      // Only the Graph source has accounts. The Screen object drops the user for a demo screen.
      const userId = config.graph ? await phoneUser(request, servicesFor(env, config)) : null;
      const claimed = await screenStub(env, found.screenRef).claim(code, {
        kind: body.value.kind ?? "owner",
        ipHash: hashed,
        userId,
        passHash: null,
      });
      return respond(claimed);
    }),
  ),

  route(["GET"], "/api/pair/ws", "api", withConfig(upgrade)),

  route(
    ["GET"],
    "/api/pair/state",
    "api",
    withConfig((request, env) =>
      withScreen(
        request,
        env,
        (stub, pid) => stub.phoneView(pid),
        (view) => json(view),
      ),
    ),
  ),

  route(
    ["POST"],
    "/api/cancel",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, emptyBody);
      if (!body.ok) return body.response;
      return withScreen(
        request,
        env,
        (stub, pid) => stub.cancel(pid),
        (view) => json(view),
      );
    }),
  ),

  route(
    ["POST"],
    "/api/end",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, emptyBody);
      if (!body.ok) return body.response;
      return withScreen(
        request,
        env,
        (stub, pid) => stub.endFromPhone(pid),
        (view) => json(view),
      );
    }),
  ),
];
