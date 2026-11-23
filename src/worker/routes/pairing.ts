// Pairing routes (architecture section 6). Each handler: config, then the CSRF checks for writes
// (PAIR-06), then the platform rate limit, then Zod on the body, then one call into a Durable Object.
import { z } from "zod";
import { normalize } from "../../../public/js/shared/codes.js";
import { type Config, configFor } from "../config.ts";
import type { Env } from "../env.ts";
import { bearer, checkOrigin, checkWrite, fail, json, readJson } from "../http.ts";
import { hmacHex, newRef, parseCredential } from "../ids.ts";
import { type Handler, type Route, route } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import { directoryStub, screenStub } from "../stubs.ts";
import { resolveStubFile } from "./stub-files.ts";

const mode = z.enum(["live", "demo"]);
const createBody = z.object({ mode }).strict();
const claimBody = z
  .object({
    code: z.string().max(32),
    pass: z.string().max(256).optional(),
    kind: z.enum(["owner", "guest"]).optional(),
  })
  .strict();
const approveBody = z.object({ fileId: z.string().min(1).max(256) }).strict();
const emptyBody = z.object({}).strict();

const REF = /^[A-Za-z0-9_-]{22}$/;

type WithConfig = (request: Request, env: Env, config: Config) => Response | Promise<Response>;

/** Fails closed with 500 when the configuration is invalid. */
const withConfig =
  (handler: WithConfig): Handler =>
  (request, env) => {
    const config = configFor(env);
    if (!config.ok) {
      console.error(`config invalid: ${config.problems.join("; ")}`);
      return fail("internal");
    }
    return handler(request, env, config.config);
  };

const respond = <T>(result: Result<T>, status = 200): Response =>
  result.ok ? json(result.value, status) : fail(result.error);

/** Coarse platform limit per pseudonymous IP. Skipped when the binding is absent or under TEST_TIMING. */
async function limited(binding: RateLimit | undefined, request: Request, config: Config): Promise<Response | null> {
  if (config.testTiming || typeof binding?.limit !== "function") return null;
  const key = await ipHash(request, config);
  return (await binding.limit({ key })).success ? null : fail("rate_limited");
}

/** Never stored raw: HMAC with the pepper. Local dev has no CF-Connecting-IP and shares one key. */
const ipHash = (request: Request, config: Config): Promise<string> =>
  hmacHex(config.hashPepper, request.headers.get("CF-Connecting-IP") ?? "local");

/** A write route: checks, then the JSON body. */
async function write<T>(
  request: Request,
  config: Config,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const refused = checkWrite(request, config.origin);
  return refused ? { ok: false, response: refused } : readJson(request, schema);
}

/** Runs `call` against the Screen object a credential names, or answers 401. */
async function withScreen<T>(
  request: Request,
  env: Env,
  call: (stub: ReturnType<typeof screenStub>, credential: string) => Promise<Result<T>>,
  ok: (value: T) => Response,
): Promise<Response> {
  const value = bearer(request);
  const cred = value ? parseCredential(value) : null;
  if (!value || !cred) return fail("unauthorized");
  const result = await call(screenStub(env, cred.ref), value);
  return result.ok ? ok(result.value) : fail(result.error);
}

/** WebSocket upgrade: the Origin must be ours; the credential is the first frame, so the URL carries only the ref. */
async function upgrade(request: Request, env: Env, config: Config): Promise<Response> {
  const refused = checkOrigin(request, config.origin);
  if (refused) return refused;
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail("bad_request");
  const ref = new URL(request.url).searchParams.get("ref") ?? "";
  if (!REF.test(ref)) return fail("bad_request");
  return screenStub(env, ref).fetch(request);
}

export const pairingRoutes: readonly Route[] = [
  route(
    ["POST"],
    "/api/screens",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, createBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env.RL_CREATE, request, config);
      if (tooMany) return tooMany;
      if (body.value.mode === "demo" && !config.demoEnabled) return fail("not_found");
      const screenRef = newRef();
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
    withConfig((request, env) =>
      withScreen(
        request,
        env,
        (stub, sid) => stub.screenView(sid),
        (view) => json(view),
      ),
    ),
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
      const tooMany = await limited(env.RL_CLAIM, request, config);
      if (tooMany) return tooMany;
      const code = normalize(body.value.code);
      if (!code) return fail("code_malformed");
      // Guest passes are issued by a later module; until then a pass can only be invalid.
      if (body.value.pass !== undefined) return fail("pass_invalid");
      const hashed = await ipHash(request, config);
      const found = await directoryStub(env).lookup(code, hashed, Date.now());
      if (!found.ok) return fail(found.error);
      const claimed = await screenStub(env, found.screenRef).claim(code, {
        kind: body.value.kind ?? "owner",
        ipHash: hashed,
        userId: null,
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
    "/api/approve",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, approveBody);
      if (!body.ok) return body.response;
      const file = resolveStubFile(body.value.fileId);
      if (!file) return fail("file_not_found");
      return withScreen(
        request,
        env,
        (stub, pid) => stub.approve(pid, body.value.fileId, file),
        (view) => json(view),
      );
    }),
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
