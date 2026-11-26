// Which FileSource serves a screen, and for whom. The source is decided here from the screen's mode (fixed
// at creation, read from the Screen object) and FILE_SOURCE, never from anything the client sends (SRC-04).
import type { Entry, LinkEntry, Mode, SourceError } from "../shared/protocol.ts";
import { refresher } from "./auth/oauth.ts";
import { phoneUser, servicesFor } from "./auth/services.ts";
import type { Config } from "./config.ts";
import type { Env } from "./env.ts";
import { fail } from "./http.ts";
import { allowedLink, allowedPreview, type ItemDraft } from "./items.ts";
import { DEMO_LINKS, demoSource } from "./seams/file-source/demo.ts";
import { GraphFileSource } from "./seams/file-source/graph.ts";
import type { FileSource, SourceContext } from "./seams/file-source/index.ts";

/** The phone lists, and may approve, at most this many recent files, plus the account's links. */
export const LIST_LIMIT = 5;

/** `links`: the account's web links. Only the demo account has any; Graph offers none. */
export type Access =
  | { ok: true; source: FileSource; ctx: SourceContext; links: readonly LinkEntry[] }
  | { ok: false; response: Response };

/**
 * Demo screens and FILE_SOURCE=mock use the demo account: no sign-in, no cookie read, no vault.
 * Only a live screen with FILE_SOURCE=graph builds a GraphFileSource, for the user the session cookie names.
 */
export async function accessFor(request: Request, env: Env, config: Config, mode: Mode): Promise<Access> {
  if (mode === "demo" || !config.graph) return accessForUser(env, config, mode, null);
  const userId = await phoneUser(request, servicesFor(env, config));
  return userId ? accessForUser(env, config, mode, userId) : { ok: false, response: fail("auth_required") };
}

/**
 * The same choice for a request with no phone cookie: PowerPoint fetching /f/ reads as the account the
 * session approved with, which the Screen object kept (`UsedLink.userId`).
 */
export async function accessForUser(env: Env, config: Config, mode: Mode, userId: string | null): Promise<Access> {
  if (mode === "demo" || !config.graph) {
    return {
      ok: true,
      source: demoSource(),
      ctx: { mode, userId: null, folderId: null, accessToken: noToken },
      links: DEMO_LINKS,
    };
  }
  if (!userId) return { ok: false, response: fail("auth_required") };
  const services = servicesFor(env, config);
  const refresh = refresher(config.graph, { fetch: (input, init) => fetch(input, init) });
  return {
    ok: true,
    source: new GraphFileSource({ fetch: (input, init) => fetch(input, init), downloadHosts: config.downloadHosts }),
    ctx: {
      mode,
      userId,
      folderId: await services.vault.folderId(userId),
      accessToken: () => services.vault.accessToken(userId, refresh),
    },
    links: [],
  };
}

const noToken: SourceContext["accessToken"] = async () => ({ ok: false, error: "auth_required" });

/** The phone's list: the recent files, then every link `allowedLink` accepts, as the URL it normalized (LINK-01). */
export async function listEntries(
  access: Extract<Access, { ok: true }>,
): Promise<{ ok: true; entries: Entry[] } | { ok: false; error: SourceError }> {
  const listed = await access.source.listRecent(access.ctx, LIST_LIMIT);
  if (!listed.ok) return listed;
  return {
    ok: true,
    entries: [
      ...listed.files,
      ...access.links.flatMap((l) => {
        const url = allowedLink(l.url);
        // A link whose preview is not a same-origin thumbnail path is not listed at all (PREVIEW-01).
        const previewOk = l.preview === undefined || allowedPreview(l.preview) !== null;
        return url && previewOk ? [{ ...l, url }] : [];
      }),
    ],
  };
}

/** The server's own record of the entries the phone named by id: each must be in the current list (SRC-02). */
export async function resolveListed(
  access: Extract<Access, { ok: true }>,
  ids: readonly string[],
): Promise<{ ok: true; items: ItemDraft[] } | { ok: false; error: SourceError }> {
  const listed = await listEntries(access);
  if (!listed.ok) return listed;
  const items: ItemDraft[] = [];
  for (const id of ids) {
    const entry = listed.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: "file_not_found" };
    items.push(
      entry.kind === "link"
        ? {
            kind: "link",
            ref: entry.id,
            url: entry.url,
            title: entry.title,
            ...(entry.preview ? { preview: entry.preview } : {}),
          }
        : {
            kind: "file",
            source: access.source.kind,
            ref: entry.id,
            name: entry.name,
            type: entry.type,
            ...(entry.size === null ? {} : { size: entry.size }),
          },
    );
  }
  return { ok: true, items };
}
