// Library routes (/api/library/*, ADR 0016, docs/library.md). Every route needs a member (label C), spends RL_LIBRARY keyed
// by the user, and answers `no-store`. The user id comes from the session and nowhere else (LIB-01): a foreign file id gets
// the same 404 as an unknown one. Every write is an absolute state, so a doubled request lands the same result.
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, checkWrite, fail, json, readJson, revalidated } from "../http.ts";
import { idempotency } from "../idem.ts";
import { newRef } from "../ids.ts";
import { type Member, type Resolved, resolveMember } from "../library/member.ts";
import { mintPreview } from "../library/preview.ts";
import { addSample } from "../library/sample.ts";
import { sampleDeck } from "../library/sample-deck.ts";
import {
  CURSOR_MAX_CHARS,
  type FileRow,
  fileRow,
  libDbOf,
  listFiles,
  makeDue,
  openUploads,
  overview,
  rename,
  restore,
  servable,
  setSelected,
  setUpNext,
  trash,
  UP_NEXT_MAX,
  upNext,
} from "../library/store.ts";
import { limitsWire, wireRow } from "../library/wire.ts";
import { type Route, route } from "../router.ts";
import { userLibraryStub } from "../stubs.ts";
import { limited, withConfig } from "./common.ts";
import { makeExportRoute } from "./library-export.ts";

/** A switch's value in force: `on`, `readonly` (reads work, writes stop) or `off`. G's registry decides it. */
export type SwitchValue = "on" | "readonly" | "off";
export interface Switches {
  uploads: SwitchValue;
  previews: SwitchValue;
  export: SwitchValue;
}

export interface LibraryDeps {
  resolve(request: Request, env: Env, config: Config, now: number): Promise<Resolved>;
  switches(env: Env): Promise<Switches>;
  now(): number;
}

const ID = z.string().min(1).max(64);
const empty = z.strictObject({});
const query = z.strictObject({
  view: z.enum(["files", "trash"]).default("files"),
  sort: z.enum(["updated", "name", "size"]).default("updated"),
  cursor: z.string().min(1).max(CURSOR_MAX_CHARS).optional(),
});
const patchBody = z.union([z.strictObject({ name: z.string().max(400) }), z.strictObject({ selected: z.boolean() })]);
const upNextBody = z.strictObject({ ids: z.array(ID).max(UP_NEXT_MAX) });
/** 150 ids at 25 characters each stay under the body cap that every JSON route shares. */
const deleteBody = z.union([
  z.strictObject({ ids: z.array(ID).min(1).max(150) }),
  z.strictObject({ all: z.literal(true) }),
]);
const previewBody = z.strictObject({ asset: z.enum(["bundle", "original"]) });

/**
 * Where preview links point: the file origin, which keeps a served file out of the app's own origin (LIB-05). Without one
 * no link is minted; only the test harness may fall back to the app's origin.
 */
const fileBase = (config: Config): string | null =>
  config.library.fileOrigin ?? (config.testTiming ? config.origin : null);

/** A thumbnail's token expires on a 150 s boundary, so the list answer (and its ETag) holds still between refreshes. */
const TOKEN_STEP_MS = 150_000;

// transitional: G: the spend guard's registry replaces this; every switch reads as on until then
const allOn = async (): Promise<Switches> => ({
  uploads: "on",
  previews: "on",
  export: "on",
});

export const defaultDeps: LibraryDeps = {
  // transitional: A: A's member resolver replaces this one
  resolve: (request, env, config, now) => resolveMember(request, env, config, now),
  switches: allOn,
  now: Date.now,
};

interface Ctx {
  request: Request;
  env: Env;
  config: Config;
  member: Member;
  now: number;
}

type Handler = (ctx: Ctx, match: URLPatternResult) => Response | Promise<Response>;
/** `write` adds the Origin and JSON checks; `upgrade` checks the Origin alone, before any session work. */
type Kind = "read" | "write" | "upgrade";

export function makeLibraryRoutes(deps: LibraryDeps): readonly Route[] {
  /** The front of every route: config, the request checks, the member, then the platform limit. */
  const member =
    (handler: Handler, kind: Kind) =>
    (request: Request, env: Env, match: URLPatternResult): Promise<Response> | Response =>
      withConfig(async (req, e, config) => {
        const refused =
          kind === "write"
            ? checkWrite(req, config.origin)
            : kind === "upgrade"
              ? checkOrigin(req, config.origin)
              : null;
        if (refused) return refused;
        const now = deps.now();
        const who = await deps.resolve(req, e, config, now);
        if (!who.ok) return who.response;
        const tooMany = await limited(e, "RL_LIBRARY", req, config, who.member.userId);
        if (tooMany) return tooMany;
        return handler({ request: req, env: e, config, member: who.member, now }, match);
      })(request, env, match);

  const fileId = (match: URLPatternResult) => match.pathname.groups.id ?? "";

  /** A thumbnail link once slides exist: a bundle token, so the browser may load it in an img. */
  async function thumbFor(ctx: Ctx, row: FileRow, previewsOn: boolean): Promise<string | null> {
    const key = ctx.config.secrets.fileTokenKey;
    const base = fileBase(ctx.config);
    if (!previewsOn || !key || !base) return null;
    if (row.derived.state !== "ready" || row.trashedAt !== null || row.disabled) return null;
    const exp = (Math.floor(ctx.now / TOKEN_STEP_MS) + 2) * TOKEN_STEP_MS;
    const { token } = await mintPreview(key, { f: row.id, v: row.version, a: "bundle" }, ctx.now, exp - ctx.now);
    return `${base}/p/${token}/t.webp`;
  }

  /** A list reads the switches and the progress once and passes them to every row; a single row reads its own. */
  const wireOf = async (
    ctx: Ctx,
    row: FileRow,
    shared?: { previewsOn: boolean; progress: ReadonlyMap<string, { done: number; total: number }> },
  ) => {
    const previewsOn = shared?.previewsOn ?? (await deps.switches(ctx.env)).previews === "on";
    return wireRow(row, await thumbFor(ctx, row, previewsOn), shared?.progress.get(row.id));
  };

  const list: Handler = async (ctx) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    if (!parsed.success) return fail("bad_request");
    const { view, sort, cursor } = parsed.data;
    const { userId } = ctx.member;
    const db = libDbOf(ctx.env.DB);
    const page = await listFiles(db, userId, view, sort, cursor ?? null);
    if (!page.ok) return fail("bad_request");
    const preparing = page.files.some((f) => f.derived.state === "preparing");
    const live = preparing ? await userLibraryStub(ctx.env, userId).currentProgress() : [];
    const { quota, trash: trashed } = await overview(db, userId, ctx.config.library.quotaBytes);
    const switches = await deps.switches(ctx.env);
    const shared = { previewsOn: switches.previews === "on", progress: new Map(live.map((p) => [p.id, p])) };
    const answer = {
      view,
      sort,
      files: await Promise.all(page.files.map((f) => wireOf(ctx, f, shared))),
      next: page.next,
      uploads: await openUploads(db, userId, ctx.now),
      upNext: await upNext(db, userId),
      quota,
      trash: trashed,
      limits: limitsWire(ctx.config.library),
      switches,
      account: { state: "active" },
    };
    return revalidated(ctx.request, answer);
  };

  /** The Sample Deck, once per Idempotency-Key: a replay answers the row the first request made. */
  const sample: Handler = async (ctx) => {
    const parsed = await readJson(ctx.request, empty);
    if (!parsed.ok) return parsed.response;
    const { userId } = ctx.member;
    if ((await deps.switches(ctx.env)).uploads !== "on") return fail("service_busy");
    const stub = userLibraryStub(ctx.env, userId);
    const db = libDbOf(ctx.env.DB);
    const idem = await idempotency<string>(
      ctx.request,
      "{}",
      userId,
      {
        find: async (_owner, keyHash) => {
          const hit = await stub.idemGet(`sample:${keyHash}`);
          return hit ? { bodyHash: hit.bodyHash, stored: hit.answer } : null;
        },
      },
      ctx.now,
    );
    if (idem.kind === "bad" || idem.kind === "conflict") return fail("bad_request");
    if (idem.kind === "replay") {
      const again = await fileRow(db, userId, idem.stored);
      return again ? json(await wireOf(ctx, again)) : fail("not_found");
    }
    const added = await addSample(ctx.env, userId, sampleDeck(), ctx.config.library, newRef(), ctx.now);
    if (!added.ok) return fail(added.error);
    if (idem.kind === "fresh") await stub.idemPut(`sample:${idem.keyHash}`, idem.bodyHash, added.id);
    const row = await fileRow(db, userId, added.id);
    return row ? json(await wireOf(ctx, row), 201) : fail("internal");
  };

  const patch: Handler = async (ctx, match) => {
    const parsed = await readJson(ctx.request, patchBody);
    if (!parsed.ok) return parsed.response;
    const { userId } = ctx.member;
    const db = libDbOf(ctx.env.DB);
    const id = fileId(match);
    const changed =
      "name" in parsed.value
        ? await rename(db, userId, id, parsed.value.name)
        : await setSelected(db, userId, id, parsed.value.selected, ctx.now);
    if (changed !== "ok") return fail(changed);
    const row = await fileRow(db, userId, id);
    return row ? json(await wireOf(ctx, row)) : fail("not_found");
  };

  const putUpNext: Handler = async (ctx) => {
    const parsed = await readJson(ctx.request, upNextBody);
    if (!parsed.ok) return parsed.response;
    return json({
      upNext: await setUpNext(libDbOf(ctx.env.DB), ctx.member.userId, parsed.value.ids, ctx.now),
    });
  };

  const moveToTrash: Handler = async (ctx, match) => {
    const parsed = await readJson(ctx.request, empty);
    if (!parsed.ok) return parsed.response;
    const { userId } = ctx.member;
    const db = libDbOf(ctx.env.DB);
    const id = fileId(match);
    const changed = await trash(db, userId, id, ctx.now, ctx.config.library.trashDays);
    if (changed !== "ok") return fail(changed);
    const row = await fileRow(db, userId, id);
    if (!row) return fail("not_found");
    const screens = await userLibraryStub(ctx.env, userId).listScreens();
    const leftScreens = screens.filter((s) => s.fileIds.includes(id)).map((s) => s.label);
    return json({ file: await wireOf(ctx, row), leftScreens });
  };

  const restoreFile: Handler = async (ctx, match) => {
    const parsed = await readJson(ctx.request, empty);
    if (!parsed.ok) return parsed.response;
    const { userId } = ctx.member;
    const db = libDbOf(ctx.env.DB);
    const id = fileId(match);
    const changed = await restore(db, userId, id, ctx.now);
    if (changed !== "ok") return fail(changed);
    const row = await fileRow(db, userId, id);
    return row ? json(await wireOf(ctx, row)) : fail("not_found");
  };

  const deleteNow: Handler = async (ctx) => {
    const parsed = await readJson(ctx.request, deleteBody);
    if (!parsed.ok) return parsed.response;
    const { userId } = ctx.member;
    const due = await makeDue(libDbOf(ctx.env.DB), userId, "all" in parsed.value ? "all" : parsed.value.ids, ctx.now);
    // A retry finds its files already due (due 0) and may still need the purge started, so the kick never depends on it.
    await userLibraryStub(ctx.env, userId).kickPurge(userId);
    return json({ due }, 202);
  };

  const preview: Handler = async (ctx, match) => {
    const parsed = await readJson(ctx.request, previewBody);
    if (!parsed.ok) return parsed.response;
    const { userId, sessionPublicId } = ctx.member;
    const key = ctx.config.secrets.fileTokenKey;
    const base = fileBase(ctx.config);
    if (!key || !base || (await deps.switches(ctx.env)).previews !== "on") return fail("service_busy");
    const db = libDbOf(ctx.env.DB);
    const row = await fileRow(db, userId, fileId(match));
    if (!row || row.trashedAt !== null) return fail("not_found");
    if (row.disabled) return fail("file_disabled");
    const pinned = { publicId: sessionPublicId, now: ctx.now };
    if (!(await servable(db, userId, [{ id: row.id, version: row.version }], pinned)).has(row.id)) {
      return fail("not_found");
    }
    const { token, exp } = await mintPreview(key, { f: row.id, v: row.version, a: parsed.value.asset }, ctx.now);
    return json({ base: `${base}/p/${token}`, exp });
  };

  /** The user's live screens: what the account page shows beside each Sign Out. Nothing internal leaves. */
  const screens: Handler = async (ctx) => {
    const rows = await userLibraryStub(ctx.env, ctx.member.userId).listScreens();
    return json({
      screens: rows.map((r) => ({
        sessionId: r.sessionId,
        label: r.label,
        fileIds: r.fileIds,
        startedAt: r.startedAt,
      })),
    });
  };

  /** Ends one live screen. Absolute: a screen that is already gone answers `ended: 0`, so a doubled request lands alike. */
  const endScreen: Handler = async (ctx, match) => {
    const parsed = await readJson(ctx.request, empty);
    if (!parsed.ok) return parsed.response;
    const { userId } = ctx.member;
    const ended = await userLibraryStub(ctx.env, userId).endScreens(userId, {
      sessionId: match.pathname.groups.sessionId ?? "",
    });
    return json({ ended });
  };

  const socket: Handler = async (ctx) => {
    if (ctx.request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail("bad_request");
    const headers = new Headers({
      Upgrade: "websocket",
      "X-Session-Public": ctx.member.sessionPublicId,
    });
    return userLibraryStub(ctx.env, ctx.member.userId).fetch(new Request(ctx.request.url, { headers }));
  };

  return [
    route(["GET"], "/api/library/ws", "api", member(socket, "upgrade")),
    route(["GET"], "/api/library", "api", member(list, "read")),
    route(["PUT"], "/api/library/up-next", "api", member(putUpNext, "write")),
    route(["POST"], "/api/library/trash/delete", "api", member(deleteNow, "write")),
    route(["POST"], "/api/library/sample", "api", member(sample, "write")),
    route(["PATCH"], "/api/library/:id", "api", member(patch, "write")),
    route(["POST"], "/api/library/:id/trash", "api", member(moveToTrash, "write")),
    route(["POST"], "/api/library/:id/restore", "api", member(restoreFile, "write")),
    route(["POST"], "/api/library/:id/preview", "api", member(preview, "write")),
    route(["GET"], "/api/me/screens", "api", member(screens, "read")),
    route(["DELETE"], "/api/me/screens/:sessionId", "api", member(endScreen, "write")),
  ];
}

// transitional: G: G's daily `take("export", 1, uid)` replaces this; the lease and RL_LIBRARY bound it until then
const takeExport = async (): Promise<boolean> => true;

export const libraryRoutes: readonly Route[] = [
  ...makeLibraryRoutes(defaultDeps),
  makeExportRoute({ ...defaultDeps, take: takeExport }),
];
