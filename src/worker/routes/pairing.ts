// Pairing routes (architecture section 6). Each handler: config, then the CSRF checks for writes
// (PAIR-06), then the platform rate limit, then Zod on the body, then one call into a Durable Object.
import { z } from "zod";
import { normalize } from "../../../public/js/shared/codes.js";
import { phoneUser, servicesFor } from "../auth/services.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, fail, json } from "../http.ts";
import { idempotency } from "../idem.ts";
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
    // transitional: removed in P1 commit 8 (the Idempotency-Key replay, REL-14: the sid's secret needs a nonce row too)
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
      const text = await request.clone().text();
      const body = await write(request, config, claimBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env, "RL_CLAIM", request, config);
      if (tooMany) return tooMany;
      const code = normalize(body.value.code);
      if (!code) return fail("code_malformed");
      const hashed = await ipHash(request, config);
      const kind = body.value.kind ?? "owner";
      // The cookie first, so a signed-out owner never spends a live code (PAIR-15).
      const userId = await phoneUser(request, servicesFor(env, config));
      // transitional: removed in P1 commit 5 (with no sign-in configured the mock source stands in for an account)
      const signedIn = userId !== null || config.graph === null;
      const found = await directoryStub(env).lookup(code, hashed, Date.now(), { kind, signedIn });
      if (!found.ok) return fail(found.error);
      if (found.demo) {
        if (!config.demoEnabled) return fail("not_found");
        const slow = await limited(env, "RL_DEMO_CLAIM", request, config);
        if (slow) return slow;
      }
      const screen = screenStub(env, found.screenRef);
      // A replay answers the first claim, so a lost answer never reads as `code_taken` (REL-14). Routing a code
      // spends nothing, so the replay is read after the lookup that names its screen. The key is scoped to a person:
      // with no account there is none to scope it to (an address is shared), so a signed-out claim replays nothing.
      const idem =
        userId === null
          ? ({ kind: "off" } as const)
          : await idempotency(request, text, userId, {
              find: (o, keyHash, since) => screen.idemFind(o, keyHash, since),
            });
      if (idem.kind === "bad" || idem.kind === "conflict") return fail("bad_request");
      if (idem.kind === "replay") return json(idem.stored);
      const claimed = await screen.claim(
        code,
        // transitional: removed in A (the signed-in phone session's public id, once sessionUser lands)
        { kind, ipHash: hashed, userId, phoneSession: null, passHash: null },
        idem.kind === "fresh" && userId !== null
          ? { owner: userId, keyHash: idem.keyHash, bodyHash: idem.bodyHash }
          : undefined,
      );
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
