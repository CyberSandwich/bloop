// Multipart upload routes (ADR 0017, docs/uploads.md): the library's under /api/uploads (a member, by the session
// cookie) and a guest's under /api/guest/uploads (a paired phone, by its Bearer pid; no cookie is read). One set of
// handlers serves both. Order on every route: the write guard, which reads only headers (Origin and Sec-Fetch-Site on
// every write; on a JSON one also its type and a declared length of at most 4096 bytes), then the caller, the rate
// limit, and the upload the path names, which must be the caller's (UP-03: a foreign or unknown id is the same 404),
// then one settings read for the switches and the deps. The one raw body is a proxy part, whose declared length must
// equal the part's before a byte is read.
import { z } from "zod";
import { ERRORS } from "../../../public/js/shared/errors.js";
import { cleanName } from "../../../public/js/shared/file-name.js";
import type { ErrorCode } from "../../shared/protocol.ts";
import { dbOf } from "../auth/db.ts";
import { resolveMember } from "../auth/member.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, checkWrite, fail, json, readJson } from "../http.ts";
import { bodyDigest, type IdemStore, idempotency } from "../idem.ts";
import { MAX_ITEMS } from "../items.ts";
import type { Route } from "../router.ts";
import { route } from "../router.ts";
import { guestDropFor } from "../seams/guest-drop/select.ts";
import { convertGuest } from "../uploads/convert-ready.ts";
import { uploadContext } from "../uploads/deps.ts";
import {
  abortGuest,
  completeGuest,
  createGuest,
  GUEST_MAX_OPEN,
  type GuestSide,
  meteredFor,
  putGuestPart,
} from "../uploads/guest.ts";
import * as pipeline from "../uploads/pipeline.ts";
import * as store from "../uploads/store.ts";
import { ipHash, limited, screenFor, withConfig } from "./common.ts";

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

type Refused = { ok: false; response: Response };
type Rate = "RL_LIBRARY" | "RL_UPLOAD_PART";
type Kind = store.Owner["kind"];

/** A paired phone behind its Bearer pid, and the session its uploads belong to. */
interface Guest {
  pid: string;
  stub: NonNullable<ReturnType<typeof screenFor>>["stub"];
  screenRef: string;
  sessionId: string;
  /** False until the first create turns the pairing into a guest's (`beginDrop`). */
  isGuest: boolean;
}

/** Who calls: a library member, or a guest. The owner scopes every row lookup. */
interface Caller {
  owner: store.Owner;
  guest: Guest | null;
}

const refuse = (response: Response): Refused => ({ ok: false, response });

/**
 * The signed-in library member behind the session cookie: the coarse per-IP meter first, so no D1 read goes unmetered
 * (AUTH-19), then the C gate every member route uses, whose refusal is `auth_required`.
 */
async function memberOf(request: Request, env: Env, config: Config): Promise<{ ok: true; userId: string } | Refused> {
  const flood = await limited(env, "RL_MEMBER_IP", request, config);
  if (flood) return refuse(flood);
  const who = await resolveMember(request, env, config);
  return who.ok ? { ok: true, userId: who.member.userId } : who;
}

/**
 * A guest phone behind its Bearer pid: the credential's shape, the platform limit (a create's per address, any other
 * per screen), then the Screen object's word on the session. Never reads a cookie, so a member signed in on the same
 * phone changes nothing here.
 */
async function guestOf(
  request: Request,
  env: Env,
  config: Config,
  rate: "RL_UPLOAD" | "RL_UPLOAD_PART",
): Promise<{ ok: true; guest: Guest } | Refused> {
  const screen = screenFor(request, env);
  if (!screen) return refuse(fail("unauthorized"));
  const tooMany = await limited(env, rate, request, config, rate === "RL_UPLOAD" ? undefined : screen.ref);
  if (tooMany) return refuse(tooMany);
  const session = await screen.stub.dropSession(screen.credential);
  if (!session.ok) return refuse(fail(session.error));
  return {
    ok: true,
    guest: {
      pid: screen.credential,
      stub: screen.stub,
      screenRef: screen.ref,
      sessionId: session.value.sessionId,
      isGuest: session.value.guest,
    },
  };
}

const guestOwner = (g: Guest): store.Owner => ({ kind: "guest", sessionId: g.sessionId, screenRef: g.screenRef });

/** The caller past its rate limit: a member keyed by user, a guest by screen. */
async function callerOf(
  request: Request,
  env: Env,
  config: Config,
  kind: Kind,
  rate: Rate,
): Promise<{ ok: true; caller: Caller } | Refused> {
  if (kind === "guest") {
    const g = await guestOf(request, env, config, "RL_UPLOAD_PART");
    if (!g.ok) return g;
    // Only a guest's pairing has uploads; an owner's that never sent a file names none.
    if (!g.guest.isGuest) return refuse(fail("not_found"));
    return { ok: true, caller: { owner: guestOwner(g.guest), guest: g.guest } };
  }
  const m = await memberOf(request, env, config);
  if (!m.ok) return m;
  const tooMany = await limited(env, rate, request, config, m.userId);
  if (tooMany) return refuse(tooMany);
  return { ok: true, caller: { owner: { kind: "library", userId: m.userId }, guest: null } };
}

const owns = (o: store.Owner, row: store.UploadRow): boolean =>
  row.ownerKind === o.kind && (o.kind === "library" ? row.userId === o.userId : row.sessionId === o.sessionId);

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
  kind: Kind,
  rate: Rate,
): Promise<{ ok: true; caller: Caller; row: store.UploadRow; n: number } | Refused> {
  const who = await callerOf(request, env, config, kind, rate);
  if (!who.ok) return who;
  // /api/uploads/:id/parts/:n, or one segment deeper under /api/guest.
  const segments = new URL(request.url).pathname.split("/").slice(kind === "guest" ? 1 : 0);
  const row = await store.get(dbOf(env.DB), segments[3] ?? "");
  if (!row || !owns(who.caller.owner, row)) return refuse(fail("not_found"));
  return { ok: true, caller: who.caller, row, n: Number(segments[5]) };
}

interface Call {
  request: Request;
  env: Env;
  config: Config;
  ctx: ExecutionContext;
  caller: Caller;
  row: store.UploadRow;
  n: number;
  /** A guest's deps count R2 operations on the guest meter too (meteredFor). */
  d: pipeline.Deps;
  /** A guest's storage and Screen; null for a member. */
  side: GuestSide | null;
  uploads: string;
}
type Handler = (c: Call) => Promise<Response>;

/**
 * A write on one upload: the guard, the caller and the row, then the switch. The library's `off` refuses all but
 * `always`; a guest's started upload goes on (guest_files `stopped` refuses only a new one).
 */
const owned = (kind: Kind, rate: Rate, body: "json" | "raw", handler: Handler, options: { always?: boolean } = {}) =>
  withConfig(async (request, env, config, ctx) => {
    const refused = guard(request, config, body);
    if (refused) return refused;
    const loaded = await load(request, env, config, kind, rate);
    if (!loaded.ok) return loaded.response;
    const { d, uploads } = await uploadContext(env, config, ctx);
    if (kind === "library" && !options.always && uploads === "off") return fail("service_busy");
    const { caller, row, n } = loaded;
    const side = caller.guest ? sideOf(env, config, caller.guest) : null;
    return handler({
      request,
      env,
      config,
      ctx,
      caller,
      row,
      n,
      d: side ? meteredFor(d, side) : d,
      side,
      uploads: kind === "guest" ? "on" : uploads,
    });
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

/** A create's body, cleaned, and its Idempotency-Key against the owner: a replay or a bad key is answered here. */
async function createRequest(
  request: Request,
  d: pipeline.Deps,
  owner: store.Owner,
): Promise<{ ok: true; req: pipeline.CreateRequest } | Refused> {
  const body = await readJson(request, createBody);
  if (!body.ok) return body;
  const name = cleanName(body.value.name);
  if (name === "") return refuse(fail("bad_request"));
  const { bytes, fingerprint } = body.value;
  const ownerKey = store.ownerId(owner);
  const idem = await idempotency(request, canonical(name, bytes, fingerprint), ownerKey, idemStore(d), d.now());
  if (idem.kind === "bad" || idem.kind === "conflict") return refuse(fail("bad_request"));
  if (idem.kind === "replay") {
    return refuse(store.isOpen(idem.stored) ? reply(await pipeline.answerFor(d, idem.stored)) : fail("upload_gone"));
  }
  return { ok: true, req: { name, bytes, fingerprint, idemKey: idem.kind === "fresh" ? idem.keyHash : null } };
}

const created = (made: pipeline.Created): Response =>
  reply(made, made.ok && made.value.created ? 201 : 200, (v) => v.answer);

/** A caller's live uploads, for the paused rows of a page that lost its files. */
const list = (kind: Kind) =>
  withConfig(async (request, env, config) => {
    const who = await callerOf(request, env, config, kind, "RL_LIBRARY");
    if (!who.ok) return who.response;
    return json({ uploads: await store.listOpen(dbOf(env.DB), who.caller.owner, Date.now()) });
  });

const createLibrary = withConfig(async (request, env, config, ctx) => {
  const refused = guard(request, config, "json");
  if (refused) return refused;
  const who = await callerOf(request, env, config, "library", "RL_LIBRARY");
  if (!who.ok) return who.response;
  const { owner } = who.caller;
  const { d, uploads } = await uploadContext(env, config, ctx);
  if (uploads !== "on") return fail("service_busy");
  const parsed = await createRequest(request, d, owner);
  if (!parsed.ok) return parsed.response;
  return created(await pipeline.createLibrary(d, store.ownerId(owner), parsed.req));
});

/** A code the Screen object can carry as a refusal's cause; the library's own codes are `internal` there. */
const causeOf = (error: unknown): ErrorCode =>
  typeof error === "string" && Object.hasOwn(ERRORS, error) ? (error as ErrorCode) : "internal";

/** What a guest's upload moves outside the upload table: the guest storage, and the Screen once the file is ready. */
function sideOf(env: Env, config: Config, g: Guest): GuestSide {
  const drop = guestDropFor(env, config);
  return {
    sessionId: g.sessionId,
    screenRef: g.screenRef,
    reserve: (r2Key, bytes, name, type) => drop.reserve(g.sessionId, r2Key, bytes, name, type),
    async settle(file) {
      if (!(await drop.settle(g.sessionId, file))) return false;
      const offered = await g.stub.dropDone(g.pid, {
        source: "guest",
        ref: file.r2Key,
        name: file.name,
        type: file.kind,
        size: file.size,
      });
      return offered.ok;
    },
    async forget(r2Key) {
      await drop.purge(g.sessionId, r2Key).catch(() => console.error("guest_delete_failed"));
    },
    charge: (cls, n) => drop.charge(cls, n),
  };
}

const createForGuest = withConfig(async (request, env, config, ctx) => {
  const refused = guard(request, config, "json");
  if (refused) return refused;
  const who = await guestOf(request, env, config, "RL_UPLOAD");
  if (!who.ok) return who.response;
  const g = who.guest;
  const owner = guestOwner(g);
  const side = sideOf(env, config, g);
  const context = await uploadContext(env, config, ctx);
  if (context.guestFiles === "stopped") return fail("service_busy");
  const d = meteredFor(context.d, side);
  const parsed = await createRequest(request, d, owner);
  if (!parsed.ok) return parsed.response;
  const { req } = parsed;
  // A new file goes past the Screen first (its policy, its cap, the move to uploading); a resume of a live one does not.
  const resuming = (await store.findOpen(d.db, owner, req.fingerprint, d.now())) !== null;
  if (!resuming) {
    const began = await g.stub.beginDrop(g.pid, req.bytes);
    if (!began.ok) return fail(began.error);
  }
  const made = await createGuest(d, side, req, {
    maxBytes: config.guestMaxBytes,
    maxFiles: MAX_ITEMS,
    maxOpen: GUEST_MAX_OPEN,
    expiryMs: config.uploadTimeoutSeconds * 1000,
  });
  // The Screen moved to uploading for this file: a refusal returns it, so the phone can choose another.
  if (!made.ok && !resuming) await g.stub.dropFailed(g.pid, causeOf(made.error));
  return created(made);
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

/** The share of a guest upload stored so far, to the room screen; after the response, never failing the part. */
async function reportProgress(c: Call, g: Guest): Promise<void> {
  const stored = (await store.doneParts(c.d.db, c.row.id)).reduce((sum, p) => sum + p.bytes, 0);
  const sent = await g.stub.uploadProgress(g.pid, { uploadId: c.row.id, fraction: Math.min(1, stored / c.row.bytes) });
  if (!sent.ok) console.error(JSON.stringify({ evt: "upload_progress_refused", code: sent.error }));
}

const putPart: Handler = async (c) => {
  const declared = c.request.headers.get("Content-Length") ?? "";
  if (!/^\d{1,12}$/.test(declared) || c.request.body === null) return fail("length_required");
  const g = c.caller.guest;
  if (!g || !c.side) return reply(await pipeline.putPart(c.d, c.row, c.n, c.request.body, Number(declared)));
  const out = await putGuestPart(c.d, c.side, c.row, c.n, c.request.body, Number(declared));
  if (out.ok) c.ctx.waitUntil(reportProgress(c, g).catch(() => console.error("upload_progress_failed")));
  // The guest meter's cap cancelled the upload: the Screen goes back for another file.
  else if (out.error === "storage_full") await g.stub.dropFailed(g.pid, "storage_full");
  return reply(out);
};

const done: Handler = async ({ request, row, n, d }) => {
  const body = await readJson(request, doneBody);
  if (!body.ok) return body.response;
  return reply(await pipeline.confirmPart(d, row, n, body.value.etag, body.value.bytes));
};

const complete: Handler = async ({ request, env, ctx, config, caller, row, d, side }) => {
  const body = await readJson(request, completeBody);
  if (!body.ok) return body.response;
  const g = caller.guest;
  if (!g || !side) {
    const last = "n" in body.value ? { n: body.value.n, etag: body.value.etag, bytes: body.value.bytes } : undefined;
    return reply(await pipeline.completeLibrary(d, row, last));
  }
  // A guest's parts are proxied: no client ETag rides on complete (UP-08).
  if ("n" in body.value) return fail("bad_request");
  const out = await completeGuest(d, side, row);
  if (out.ok && out.value.state === "ready" && row.completedAt === null) {
    const scope = await ipHash(request, config);
    await convertGuest(env, ctx, { sessionId: g.sessionId, screenRef: g.screenRef, ipHash: scope });
  } else if (out.ok && out.value.state === "refused") {
    await g.stub.dropFailed(g.pid, causeOf(out.value.file.refusal));
  }
  return reply(out);
};

/** A pure read of D1: no settings read, no R2, no charge, so it needs no switch. */
const read = (kind: Kind) =>
  withConfig(async (request, env, config) => {
    const loaded = await load(request, env, config, kind, "RL_UPLOAD_PART");
    if (!loaded.ok) return loaded.response;
    return json(await pipeline.stateOf({ db: dbOf(env.DB), now: Date.now }, loaded.row));
  });

const cancel: Handler = async ({ caller, row, d, side }) => {
  const g = caller.guest;
  const out = g && side ? await abortGuest(d, side, row) : await pipeline.abortLibrary(d, row);
  if (g && out.ok && store.isOpen(row)) await g.stub.dropFailed(g.pid, "upload_aborted");
  return out.ok ? new Response(null, { status: 204 }) : fail(out.error);
};

/** The routes of one owner kind under `base`: create is the kind's own, every other handler is shared. */
const routesOf = (kind: Kind, base: string, create: ReturnType<typeof withConfig>): Route[] => [
  route(["GET"], base, "api", list(kind)),
  route(["POST"], base, "api", create),
  route(["POST"], `${base}/:id/urls`, "api", owned(kind, "RL_UPLOAD_PART", "json", urls)),
  route(["PUT"], `${base}/:id/parts/:n`, "api", owned(kind, "RL_UPLOAD_PART", "raw", putPart)),
  route(["POST"], `${base}/:id/parts/:n/done`, "api", owned(kind, "RL_UPLOAD_PART", "json", done)),
  route(["POST"], `${base}/:id/complete`, "api", owned(kind, "RL_LIBRARY", "json", complete)),
  route(["GET"], `${base}/:id`, "api", read(kind)),
  route(["DELETE"], `${base}/:id`, "api", owned(kind, "RL_UPLOAD_PART", "raw", cancel, { always: true })),
];

export const uploadRoutes: readonly Route[] = [
  ...routesOf("library", "/api/uploads", createLibrary),
  ...routesOf("guest", "/api/guest/uploads", createForGuest),
];
