// Multipart upload routes (ADR 0017, docs/uploads.md). Every id route loads the upload and checks its owner before
// anything else (UP-03): a foreign or unknown id is the same 404. Every write passes the guard (Origin, Sec-Fetch-Site,
// JSON, strict zod); the one raw body is a proxy part, whose declared length must equal the part's before a byte is read.
import { z } from "zod";
import { cleanName } from "../../../public/js/shared/names.js";
import { readCookie, SESSION_COOKIE } from "../auth/cookies.ts";
import { dbOf } from "../auth/db.ts";
import { phoneUser, servicesFor } from "../auth/services.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, fail, json } from "../http.ts";
import { bodyDigest, type IdemStore, idempotency } from "../idem.ts";
import type { Route } from "../router.ts";
import { route } from "../router.ts";
import { uploadDepsFor as depsFor, uploadsSwitch as switchOf } from "../uploads/deps.ts";
import * as pipeline from "../uploads/pipeline.ts";
import * as store from "../uploads/store.ts";
import { limited, withConfig, write } from "./common.ts";

/** An ETag as R2 hands it back: hex in production, URL-safe base64 in the local emulator; quotes optional. */
const ETAG = /^"?[A-Za-z0-9_=+/-]{16,200}"?$/;
const createBody = z.strictObject({
  name: z.string().min(1).max(200),
  bytes: z.number().int().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
const urlsBody = z.strictObject({
  parts: z.array(z.number().int().min(1)).min(1).max(pipeline.MINT_BATCH),
});
const doneBody = z.strictObject({
  etag: z.string().regex(ETAG),
  bytes: z.number().int().min(1),
});
const completeBody = z.union([
  z.strictObject({}),
  z.strictObject({
    n: z.number().int().min(1),
    etag: z.string().regex(ETAG),
    bytes: z.number().int().min(1),
  }),
]);

/** The signed-in library member behind the session cookie: active and not suspended. */
async function memberOf(request: Request, env: Env, config: Config): Promise<string | null> {
  if (!readCookie(request, SESSION_COOKIE)) return null;
  const services = servicesFor(env, config);
  const userId = await phoneUser(request, services);
  return userId && (await services.sessions.activeMemberEmail(userId)) ? userId : null;
}

const reply = <T>(out: pipeline.Out<T>, status = 200, map: (value: T) => unknown = (v) => v): Response =>
  out.ok ? json(map(out.value), status) : fail(out.error, undefined, out.retryAfter);

type Handler = (request: Request, env: Env, config: Config, row: store.UploadRow, n: number) => Promise<Response>;

/** Loads the upload the path names and checks it is the caller's: any other answer is `not_found` (UP-03). */
const owned = (rate: "RL_LIBRARY" | "RL_UPLOAD_PART", handler: Handler, options: { always?: boolean } = {}) =>
  withConfig(async (request, env, config) => {
    const userId = await memberOf(request, env, config);
    if (!userId) return fail("unauthorized");
    const tooMany = await limited(env, rate, request, config, userId);
    if (tooMany) return tooMany;
    const segments = new URL(request.url).pathname.split("/");
    const row = await store.get(dbOf(env.DB), segments[3] ?? "");
    if (!row || row.userId !== userId) return fail("not_found");
    if (!options.always && (await switchOf(env)) === "off") return fail("service_busy");
    return handler(request, env, config, row, Number(segments[5]));
  });

/** The create body as the key's first request and a replay both rebuild it: the cleaned name, the size, the fingerprint. */
const canonical = (name: string, bytes: number, fingerprint: string): string =>
  JSON.stringify({ name, bytes, fingerprint });

const idemStore = (d: pipeline.Deps): IdemStore<store.UploadRow> => ({
  async find(owner, keyHash, since) {
    const row = await store.findByIdem(d.db, owner, keyHash, since);
    return row
      ? {
          bodyHash: await bodyDigest(canonical(row.name, row.bytes, row.fingerprint)),
          stored: row,
        }
      : null;
  },
});

const list = withConfig(async (request, env, config) => {
  const userId = await memberOf(request, env, config);
  if (!userId) return fail("unauthorized");
  const tooMany = await limited(env, "RL_LIBRARY", request, config, userId);
  if (tooMany) return tooMany;
  return json({
    uploads: await store.listOpen(dbOf(env.DB), userId, Date.now()),
  });
});

const create = withConfig(async (request, env, config) => {
  const userId = await memberOf(request, env, config);
  if (!userId) return fail("unauthorized");
  const body = await write(request, config, createBody);
  if (!body.ok) return body.response;
  const tooMany = await limited(env, "RL_LIBRARY", request, config, userId);
  if (tooMany) return tooMany;
  if ((await switchOf(env)) !== "on") return fail("service_busy");
  const name = cleanName(body.value.name);
  if (name === "") return fail("bad_request");
  const { bytes, fingerprint } = body.value;
  const d = await depsFor(env, config);
  const idem = await idempotency(request, canonical(name, bytes, fingerprint), userId, idemStore(d), d.now());
  if (idem.kind === "bad" || idem.kind === "conflict") return fail("bad_request");
  if (idem.kind === "replay") {
    return store.isOpen(idem.stored) ? reply(await pipeline.answerFor(d, idem.stored)) : fail("upload_gone");
  }
  const made = await pipeline.createLibrary(d, userId, {
    name,
    bytes,
    fingerprint,
    idemKey: idem.kind === "fresh" ? idem.keyHash : null,
  });
  return reply(made, made.ok && made.value.created ? 201 : 200, (v) => v.answer);
});

const urls: Handler = async (request, env, config, row) => {
  const body = await write(request, config, urlsBody);
  if (!body.ok) return body.response;
  if ((await switchOf(env)) !== "on") return fail("service_busy");
  if (new Set(body.value.parts).size !== body.value.parts.length) return fail("bad_request");
  return reply(await pipeline.urlsFor(await depsFor(env, config), row, body.value.parts), 200, (list) => ({
    urls: list,
    ttlMs: config.library.urlTtlSeconds * 1000,
  }));
};

const putPart: Handler = async (request, env, config, row, n) => {
  const refused = checkOrigin(request, config.origin);
  if (refused) return refused;
  const declared = request.headers.get("Content-Length") ?? "";
  if (!/^\d{1,12}$/.test(declared) || request.body === null) return fail("length_required");
  return reply(await pipeline.putPart(await depsFor(env, config), row, n, request.body, Number(declared)));
};

const done: Handler = async (request, env, config, row, n) => {
  const body = await write(request, config, doneBody);
  if (!body.ok) return body.response;
  return reply(await pipeline.confirmPart(await depsFor(env, config), row, n, body.value.etag, body.value.bytes));
};

const complete: Handler = async (request, env, config, row) => {
  const body = await write(request, config, completeBody);
  if (!body.ok) return body.response;
  const last = "n" in body.value ? { n: body.value.n, etag: body.value.etag, bytes: body.value.bytes } : undefined;
  return reply(await pipeline.completeLibrary(await depsFor(env, config), row, last));
};

const read: Handler = async (_request, env, config, row) =>
  json(await pipeline.stateOf(await depsFor(env, config), row));

const cancel: Handler = async (request, env, config, row) => {
  const refused = checkOrigin(request, config.origin);
  if (refused) return refused;
  const out = await pipeline.abortLibrary(await depsFor(env, config), row);
  return out.ok ? new Response(null, { status: 204 }) : fail(out.error);
};

export const uploadRoutes: readonly Route[] = [
  route(["GET"], "/api/uploads", "api", list),
  route(["POST"], "/api/uploads", "api", create),
  route(["POST"], "/api/uploads/:id/urls", "api", owned("RL_UPLOAD_PART", urls)),
  route(["PUT"], "/api/uploads/:id/parts/:n", "api", owned("RL_UPLOAD_PART", putPart)),
  route(["POST"], "/api/uploads/:id/parts/:n/done", "api", owned("RL_UPLOAD_PART", done)),
  route(["POST"], "/api/uploads/:id/complete", "api", owned("RL_LIBRARY", complete)),
  route(["GET"], "/api/uploads/:id", "api", owned("RL_UPLOAD_PART", read, { always: true })),
  route(["DELETE"], "/api/uploads/:id", "api", owned("RL_UPLOAD_PART", cancel, { always: true })),
];
