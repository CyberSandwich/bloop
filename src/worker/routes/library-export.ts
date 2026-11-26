// GET /api/me/export.zip: the account export as a download (ADR 0016, docs/library.md). A navigation, so the idempotency
// key travels as `?k=`. A fresh export needs the session's recent proof (C+R); resuming one the server issued within a day
// needs only the session (C). Every check that costs nothing runs before the first D1 read.
import { z } from "zod";
import { userScope } from "../audit.ts";
import { readCookie, SESSION_COOKIE } from "../auth/cookies.ts";
import { dbOf } from "../auth/db.ts";
import { Sessions } from "../auth/sessions.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { auditRecord } from "../export-format.ts";
import { fail } from "../http.ts";
import { newRef, safeEqual } from "../ids.ts";
import { bucketOf } from "../library/bucket.ts";
import { buildExport, exportFilename, exportStream, type Snapshot, takeSnapshot } from "../library/export.ts";
import { libDbOf } from "../library/store.ts";
import { type Route, route } from "../router.ts";
import { parseRange } from "../seams/open-path/range.ts";
import { auditFor } from "../stores.ts";
import { userLibraryStub } from "../stubs.ts";
import { limited, withConfig } from "./common.ts";
import type { LibraryDeps } from "./library.ts";

declare const FixedLengthStream: new (length: number) => TransformStream<Uint8Array, Uint8Array>;

const KEY = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const AUDIT_PAGE = 200;
/** The audit trail in the archive stops here; a user with more reads the rest from the page. */
const AUDIT_PAGES_MAX = 50;
const ETAG_LEASE_PREFIX = "export-etag:";
const KEY_PREFIX = "export-k:";

/** `Content-Disposition` with the plain name in `filename` and the same in `filename*`. */
const attachment = (name: string): string =>
  `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** The day's cap on starts is G's exact `take("export", 1, uid)`; until it lands, `take` allows. */
export interface ExportDeps extends LibraryDeps {
  take(env: Env, userId: string): Promise<boolean>;
}

export function makeExportRoute(deps: ExportDeps): Route {
  return route(
    ["GET"],
    "/api/me/export.zip",
    "api",
    withConfig(async (request, env, config) => {
      // Cross-site navigations are refused before any storage is read (LIB-10).
      if (request.headers.get("Sec-Fetch-Site") !== "same-origin") return fail("forbidden_origin");
      const params = new URL(request.url).searchParams;
      const key = KEY.safeParse(params.get("k"));
      if (!key.success) return fail("bad_request");
      const now = deps.now();
      const who = await deps.resolve(request, env, config, now);
      if (!who.ok) return who.response;
      const { userId } = who.member;
      const tooMany = await limited(env, "RL_LIBRARY", request, config, userId);
      if (tooMany) return tooMany;
      const tokenKey = config.secrets.fileTokenKey;
      if (!tokenKey || (await deps.switches(env)).export !== "on") return fail("export_paused");
      return start({ request, env, config, userId, now, k: key.data, tokenKey, take: deps.take });
    }),
  );
}

interface Start {
  request: Request;
  env: Env;
  config: Config;
  userId: string;
  now: number;
  k: string;
  tokenKey: string;
  take(env: Env, userId: string): Promise<boolean>;
}

async function start(s: Start): Promise<Response> {
  const { request, env, config, userId, now } = s;
  const stub = userLibraryStub(env, userId);
  const rangeHeader = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  // A resume names an ETag the server issued in the last day. The first run stored its snapshot moment with it, so the
  // same archive is laid out again however long the client was away; a resume from offset 0 is a new download below.
  const issued = rangeHeader !== null && ifRange !== null ? await stub.idemGet(`${ETAG_LEASE_PREFIX}${ifRange}`) : null;
  const issuedAt = issued === null ? Number.NaN : Number(issued.answer);
  const resumes = Number.isSafeInteger(issuedAt);
  const takenAt = resumes ? issuedAt : now;
  if (!resumes) {
    const cookie = readCookie(request, SESSION_COOKIE) ?? "";
    const fresh = await new Sessions(dbOf(env.DB), () => now).reauthedWithin(
      cookie,
      config.account.reauthSeconds * 1000,
    );
    if (!fresh) return fail("reauth_required");
  }
  // The same key while its lease is live is a retried navigation: it never takes a second lease.
  if ((await stub.idemGet(`${KEY_PREFIX}${s.k}`)) !== null && (await stub.exportActive())) return fail("export_busy");
  const holder = newRef();
  if (!(await stub.exportBegin(holder))) return fail("export_busy");
  let handed = false;
  try {
    if (!resumes && !(await s.take(env, userId))) return fail("export_limit");
    const db = libDbOf(env.DB);
    const audit: Snapshot["audit"][number][] = [];
    let before: number | undefined;
    for (let page = 0; page < AUDIT_PAGES_MAX; page++) {
      const rows = await auditFor(env).forUser(userId, AUDIT_PAGE, before);
      // An export's own row is left out: it is written after the snapshot, so a resume would never match the first run.
      audit.push(...rows.filter((r) => r.type !== "library.export").map((r) => ({ at: r.at, record: auditRecord(r) })));
      if (rows.length < AUDIT_PAGE) break;
      before = rows.at(-1)?.at;
    }
    const built = await buildExport(
      await takeSnapshot(db, userId, audit, config.library.quotaBytes, takenAt),
      s.tokenKey,
    );
    const { archive, etag } = built;
    const matches = resumes && ifRange !== null && safeEqual(ifRange, etag);
    const range = matches && rangeHeader !== null ? parseRange(rangeHeader, archive.length) : null;
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${archive.length}` } });
    }
    // A resume that changed under the client, whose Range is ignored, or that starts again from byte 0, is a whole
    // download and spends a start like one.
    if (resumes && (range === null || range.offset === 0)) {
      const cookie = readCookie(request, SESSION_COOKIE) ?? "";
      const proof = await new Sessions(dbOf(env.DB), () => now).reauthedWithin(
        cookie,
        config.account.reauthSeconds * 1000,
      );
      if (!proof) return fail("reauth_required");
      if (!(await s.take(env, userId))) return fail("export_limit");
    }
    // The run is recorded before the first byte: an export nobody can later see is worse than a failed one.
    try {
      await auditFor(env).record({
        sessionId: userScope(userId),
        at: now,
        actor: "phone",
        type: "library.export",
        detail: {},
      });
    } catch {
      console.error("export_audit_failed");
      return fail("internal");
    }
    await stub.idemPut(`${KEY_PREFIX}${s.k}`, "", etag);
    await stub.idemPut(`${ETAG_LEASE_PREFIX}${etag}`, "", String(takenAt));
    const [start, end] = range ? [range.offset, range.offset + range.length - 1] : [0, archive.length - 1];
    const length = end - start + 1;
    const body = exportStream(
      archive,
      start,
      end,
      { userId, bucket: bucketOf(env.LIBRARY) },
      () => stub.exportEnd(holder),
      () => stub.exportBeat(holder),
    );
    const fixed = new FixedLengthStream(length);
    body.pipeTo(fixed.writable).catch(() => {});
    handed = true;
    return new Response(fixed.readable, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachment(exportFilename(now)),
        "Accept-Ranges": "bytes",
        ETag: etag,
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${archive.length}` } : {}),
      },
    });
  } finally {
    if (!handed) await stub.exportEnd(holder);
  }
}

export const exportRoute = (deps: ExportDeps): Route => makeExportRoute(deps);
