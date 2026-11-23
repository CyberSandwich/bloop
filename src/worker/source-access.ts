// Which FileSource serves a screen, and for whom. The source is decided here from the screen's mode (fixed
// at creation, read from the Screen object) and FILE_SOURCE, never from anything the client sends (SRC-04).
import type { FileEntry, Mode, SourceError } from "../shared/protocol.ts";
import { refresher } from "./auth/oauth.ts";
import { phoneUser, servicesFor } from "./auth/services.ts";
import type { Config } from "./config.ts";
import type { Env } from "./env.ts";
import { fail } from "./http.ts";
import type { FileRef } from "./machine.ts";
import { demoSource } from "./seams/file-source/demo.ts";
import { GraphFileSource } from "./seams/file-source/graph.ts";
import type { FileSource, SourceContext } from "./seams/file-source/index.ts";

/** The phone lists, and may approve, at most this many recent decks. */
export const LIST_LIMIT = 5;

export type Access = { ok: true; source: FileSource; ctx: SourceContext } | { ok: false; response: Response };

/**
 * Demo screens and FILE_SOURCE=mock use the demo account: no sign-in, no cookie read, no vault.
 * Only a live screen with FILE_SOURCE=graph builds a GraphFileSource, for the user the session cookie names.
 */
export async function accessFor(request: Request, env: Env, config: Config, mode: Mode): Promise<Access> {
  if (mode === "demo" || !config.graph) {
    return { ok: true, source: demoSource(), ctx: { mode, userId: null, folderId: null, accessToken: noToken } };
  }
  const services = servicesFor(env, config);
  const userId = await phoneUser(request, services);
  if (!userId) return { ok: false, response: fail("auth_required") };
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
  };
}

const noToken: SourceContext["accessToken"] = async () => ({ ok: false, error: "auth_required" });

/** The server's own record of a file the phone named by id: the id must be in the current list. */
export async function resolveListed(
  access: Extract<Access, { ok: true }>,
  fileId: string,
): Promise<{ ok: true; file: FileRef } | { ok: false; error: SourceError }> {
  const listed = await access.source.listRecent(access.ctx, LIST_LIMIT);
  if (!listed.ok) return listed;
  const entry: FileEntry | undefined = listed.files.find((f) => f.id === fileId);
  if (!entry) return { ok: false, error: "file_not_found" };
  return { ok: true, file: { source: access.source.kind, ref: entry.id, name: entry.name, type: entry.type } };
}
