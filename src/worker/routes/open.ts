// The open path's two routes: `/f/:token/:name`, which PowerPoint or the browser fetches, and
// `POST /api/screen/link`, where the screen asks for one more link (download, PDF, relaunch).
// Order for /f/: config, platform rate limit, token shape, the Screen object's link rules, the source, the answer.
// Every refusal before the Screen object is the same 404 as an unknown token (OPEN-01).
import { z } from "zod";
import { OPEN_MODES } from "../../shared/protocol.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { fail, json } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import { MAX_ITEMS } from "../items.ts";
import { type Route, route } from "../router.ts";
import type { Resolved } from "../seams/file-source/index.ts";
import type { GuestDrop } from "../seams/guest-drop/index.ts";
import { QuotaExhausted } from "../seams/guest-drop/index.ts";
import { guestDropFor } from "../seams/guest-drop/select.ts";
import { sourceFailure } from "../seams/open-path/index.ts";
import { clientClass, parseToken } from "../seams/open-path/links.ts";
import { openPathFor } from "../seams/open-path/select.ts";
import type { UsedLink } from "../seams/pairing.ts";
import { accessForUser } from "../source-access.ts";
import { screenStub } from "../stubs.ts";
import { ipHash, limited, withConfig, withScreen, write } from "./common.ts";

/**
 * One log line per /f/ request, for field test T3 (`wrangler tail`): what Office sends, not who. No token, no IP,
 * no raw User-Agent: the class of client, the method, whether a query or a Range came along, and the status.
 */
export function logFetch(request: Request, response: Response): void {
  console.log(
    JSON.stringify({
      evt: "open.fetch",
      method: request.method,
      client: clientClass(request.headers.get("User-Agent")),
      query: new URL(request.url).search !== "",
      range: request.headers.has("Range"),
      status: response.status,
    }),
  );
}

const linkBody = z
  .object({
    purpose: z.enum(OPEN_MODES),
    item: z
      .number()
      .int()
      .min(0)
      .max(MAX_ITEMS - 1)
      .optional(),
  })
  .strict();

/** A guest upload as a Resolved, read from the bucket. The reference is the object key. */
function guestResolved(used: UsedLink, drop: GuestDrop): Resolved {
  const { file } = used;
  return {
    name: file.name,
    type: file.type,
    size: file.size ?? null,
    url: null,
    body: async (range) => {
      try {
        const object = await drop.read(file.ref, range);
        return object
          ? { ok: true, stream: object.body, length: range ? range.length : object.size }
          : { ok: false, error: "file_not_found" };
      } catch (e) {
        // The month's R2 read cap: the open path answers it as `upstream_failed` (502), the existing "the file's store cannot serve it now" state.
        if (e instanceof QuotaExhausted) return { ok: false, error: "source_throttled" };
        throw e;
      }
    },
  };
}

/** The file the link is for, resolved now (never at approve time: download URLs expire in minutes). */
async function resolveFor(env: Env, config: Config, used: UsedLink): Promise<Resolved | Response> {
  if (used.file.source === "guest") {
    return used.purpose === "pdf" && used.file.type !== "pdf"
      ? fail("pdf_unavailable")
      : guestResolved(used, guestDropFor(env, config));
  }
  const access = await accessForUser(env, config, used.mode, used.userId);
  if (!access.ok) return fail("upstream_failed");
  const resolved =
    used.purpose === "pdf"
      ? await access.source.resolvePdf(access.ctx, used.file.ref)
      : await access.source.resolve(access.ctx, used.file.ref);
  return resolved.ok ? resolved.file : sourceFailure(resolved.error);
}

async function serveLink(request: Request, env: Env, config: Config, match: URLPatternResult): Promise<Response> {
  const tooMany = await limited(env.RL_FETCH, request, config);
  if (tooMany) return tooMany;
  const token = match.pathname.groups.token ?? "";
  const parsed = parseToken(token);
  if (!parsed) return fail("link_unknown");
  // A player reads a video in many ranges: the per-IP limit above does not bound one screen's reads (VID-02).
  const sessionLimited = await limited(env.RL_FETCH, request, config, parsed.screenRef);
  if (sessionLimited) return sessionLimited;
  const used = await screenStub(env, parsed.screenRef).useLink(await sha256Hex(token), await ipHash(request, config), {
    method: request.method,
    client: clientClass(request.headers.get("User-Agent")),
  });
  if (!used.ok) return fail(used.error);
  const file = await resolveFor(env, config, used.value);
  if (file instanceof Response) return file;
  return openPathFor(config.openPathMode, config.downloadHosts).serve(request, file, used.value.purpose);
}

export const openRoutes: readonly Route[] = [
  // GET and HEAD only: the router answers every other method (OPTIONS, PROPFIND, writes) 405 with `Allow`.
  route(["GET", "HEAD"], "/f/:token/:name", "api", (request, env, match) =>
    withConfig((req, e, config) => serveLink(req, e, config, match))(request, env, match),
  ),

  route(
    ["POST"],
    "/api/screen/link",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, linkBody);
      if (!body.ok) return body.response;
      return withScreen(
        request,
        env,
        (stub, sid) => stub.mintFallback(sid, body.value.purpose, body.value.item ?? null),
        (minted) => json(minted),
      );
    }),
  ),
];
