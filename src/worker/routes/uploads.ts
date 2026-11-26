// Multipart upload routes (ADR 0017, docs/uploads.md). Order on every route: the write guard, which reads only headers
// (Origin and Sec-Fetch-Site on every write; on a JSON one also its type and a declared length of at most 4096 bytes),
// then the member, the rate limit, and the upload the path names, which must be the caller's (UP-03: a foreign or
// unknown id is the same 404), then one settings read for the switch and the deps. The one raw body is a proxy part,
// whose declared length must equal the part's before a byte is read.
import { z } from "zod";
import { cleanName } from "../../../public/js/shared/names.js";
import { readCookie, SESSION_COOKIE } from "../auth/cookies.ts";
import { dbOf } from "../auth/db.ts";
import { phoneUser, servicesFor } from "../auth/services.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, checkWrite, fail, json, readJson } from "../http.ts";
import { bodyDigest, type IdemStore, idempotency } from "../idem.ts";
import type { Route } from "../router.ts";
import { route } from "../router.ts";
import { uploadContext } from "../uploads/deps.ts";
import * as pipeline from "../uploads/pipeline.ts";
import * as store from "../uploads/store.ts";
import { limited, withConfig } from "./common.ts";

/** An ETag as R2 hands it back: hex in production, URL-safe base64 in the local emulator; quotes optional. */
const ETAG = /^"?[A-Za-z0-9_=+/-]{16,200}"?$/;
const createBody = z.strictObject({
  name: z.string().min(1),
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

/** The most a JSON write body may declare; `readJson` reads it whole, so it is capped before a byte is read. */
const MAX_JSON_BYTES = 4096;

/** A write's checks on its headers alone, before any D1 read or rate limit (CSRF first). */
function guard(request: Request, config: Config, kind: "json" | "raw"): Response | null {
  if (kind === "raw") return checkOrigin(request, config.origin);
  const refused = checkWrite(request, config.origin);
  if (refused) return refused;
  const declared = request.headers.get("Content-Length") ?? "";
  if (!/^\d{1,12}$/.test(declared)) return fail("length_required");
  return Number(declared) > MAX_JSON_BYTES ? fail("too_large") : null;
}

/** The caller, past the rate limit, and the upload the path names if it is theirs; any other upload is `not_found`. */
async function load(
  request: Request,
  env: Env,
  config: Config,
  rate: "RL_LIBRARY" | "RL_UPLOAD_PART",
): Promise<{ ok: true; row: store.UploadRow; n: number } | { ok: false; response: Response }> {
  const userId = await memberOf(request, env, config);
  if (!userId) return { ok: false, response: fail("unauthorized") };
  const tooMany = await limited(env, rate, request, config, userId);
  if (tooMany) return { ok: false, response: tooMany };
  const segments = new URL(request.url).pathname.split("/");
  const row = await store.get(dbOf(env.DB), segments[3] ?? "");
  if (!row || row.userId !== userId) return { ok: false, response: fail("not_found") };
  return { ok: true, row, n: Number(segments[5]) };
}

interface Call {
  request: Request;
  config: Config;
  row: store.UploadRow;
  n: number;
  d: pipeline.Deps;
  uploads: string;
}
type Handler = (c: Call) => Promise<Response>;

/** A write on one upload: the guard, the caller and the row, then the switch (`off` refuses all but `always`). */
const owned = (
  rate: "RL_LIBRARY" | "RL_UPLOAD_PART",
  kind: "json" | "raw",
  handler: Handler,
  options: { always?: boolean } = {},
) =>
  withConfig(async (request, env, config) => {
    const refused = guard(request, config, kind);
    if (refused) return refused;
    const loaded = await load(request, env, config, rate);
    if (!loaded.ok) return loaded.response;
    const { d, uploads } = await uploadContext(env, config);
    if (!options.always && uploads === "off") return fail("service_busy");
    return handler({ request, config, row: loaded.row, n: loaded.n, d, uploads });
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
  const refused = guard(request, config, "json");
  if (refused) return refused;
  const userId = await memberOf(request, env, config);
  if (!userId) return fail("unauthorized");
  const tooMany = await limited(env, "RL_LIBRARY", request, config, userId);
  if (tooMany) return tooMany;
  const { d, uploads } = await uploadContext(env, config);
  if (uploads !== "on") return fail("service_busy");
  const body = await readJson(request, createBody);
  if (!body.ok) return body.response;
  const name = cleanName(body.value.name);
  if (name === "") return fail("bad_request");
  const { bytes, fingerprint } = body.value;
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

const urls: Handler = async ({ request, config, row, d, uploads }) => {
  const body = await readJson(request, urlsBody);
  if (!body.ok) return body.response;
  if (uploads !== "on") return fail("service_busy");
  if (new Set(body.value.parts).size !== body.value.parts.length) return fail("bad_request");
  return reply(await pipeline.urlsFor(d, row, body.value.parts), 200, (list) => ({
    urls: list,
    ttlMs: config.library.urlTtlSeconds * 1000,
  }));
};

const putPart: Handler = async ({ request, row, n, d }) => {
  const declared = request.headers.get("Content-Length") ?? "";
  if (!/^\d{1,12}$/.test(declared) || request.body === null) return fail("length_required");
  return reply(await pipeline.putPart(d, row, n, request.body, Number(declared)));
};

const done: Handler = async ({ request, row, n, d }) => {
  const body = await readJson(request, doneBody);
  if (!body.ok) return body.response;
  return reply(await pipeline.confirmPart(d, row, n, body.value.etag, body.value.bytes));
};

const complete: Handler = async ({ request, row, d }) => {
  const body = await readJson(request, completeBody);
  if (!body.ok) return body.response;
  const last = "n" in body.value ? { n: body.value.n, etag: body.value.etag, bytes: body.value.bytes } : undefined;
  return reply(await pipeline.completeLibrary(d, row, last));
};

/** A pure read of D1: no settings read, no R2, no charge, so it needs no switch. */
const read = withConfig(async (request, env, config) => {
  const loaded = await load(request, env, config, "RL_UPLOAD_PART");
  if (!loaded.ok) return loaded.response;
  return json(await pipeline.stateOf({ db: dbOf(env.DB), now: Date.now }, loaded.row));
});

const cancel: Handler = async ({ row, d }) => {
  const out = await pipeline.abortLibrary(d, row);
  return out.ok ? new Response(null, { status: 204 }) : fail(out.error);
};

export const uploadRoutes: readonly Route[] = [
  route(["GET"], "/api/uploads", "api", list),
  route(["POST"], "/api/uploads", "api", create),
  route(["POST"], "/api/uploads/:id/urls", "api", owned("RL_UPLOAD_PART", "json", urls)),
  route(["PUT"], "/api/uploads/:id/parts/:n", "api", owned("RL_UPLOAD_PART", "raw", putPart)),
  route(["POST"], "/api/uploads/:id/parts/:n/done", "api", owned("RL_UPLOAD_PART", "json", done)),
  route(["POST"], "/api/uploads/:id/complete", "api", owned("RL_LIBRARY", "json", complete)),
  route(["GET"], "/api/uploads/:id", "api", read),
  route(["DELETE"], "/api/uploads/:id", "api", owned("RL_UPLOAD_PART", "raw", cancel, { always: true })),
];
