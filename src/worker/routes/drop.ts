// The guest drop: `PUT /api/drop` (architecture 4.4). Order: config, Origin (PAIR-06), credential shape,
// platform rate limit, declared type and length (DROP-01), the session's policy and state (DROP-05, DROP-06),
// budget, the streamed store with validation (DROP-02 to DROP-04), then the session moves to `offered`.
// Every failure after the session began ends in `dropFailed` and a deleted object.

import { cleanName, typeOfName } from "../../../public/js/shared/names.js";
import type { ErrorCode, FileType } from "../../shared/protocol.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import { checkOrigin, fail, json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { guestDropFor } from "../seams/guest-drop/select.ts";
import { limited, screenFor, withConfig } from "./common.ts";

/** What a phone's file input may declare; an unknown file type arrives as octet-stream or empty. */
const UPLOAD_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/quicktime",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const MAX_NAME_HEADER = 1024;

const mediaType = (request: Request) =>
  (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/** The display name from `X-Bloop-Name` (percent-encoded UTF-8) and the type its extension declares. */
function declaredFile(request: Request): { name: string; type: FileType } | null {
  const header = request.headers.get("X-Bloop-Name") ?? "";
  if (header.length === 0 || header.length > MAX_NAME_HEADER) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    return null;
  }
  const name = cleanName(decoded);
  const type = typeOfName(name);
  return type ? { name, type } : null;
}

async function putDrop(request: Request, env: Env, config: Config): Promise<Response> {
  const refused = checkOrigin(request, config.origin);
  if (refused) return refused;
  if (!UPLOAD_TYPES.has(mediaType(request))) return fail("unsupported_media_type");
  const screen = screenFor(request, env);
  if (!screen) return fail("unauthorized");
  const tooMany = await limited(env, "RL_UPLOAD", request, config);
  if (tooMany) return tooMany;

  const declared = request.headers.get("Content-Length") ?? "";
  if (!/^\d{1,12}$/.test(declared) || request.body === null) return fail("length_required");
  const length = Number(declared);
  if (length > config.guestMaxBytes) return fail("too_large");
  const file = declaredFile(request);
  if (!file) return fail("bad_type");

  const { stub, credential } = screen;
  const began = await stub.beginDrop(credential, length);
  if (!began.ok) return fail(began.error);
  const drop = guestDropFor(env, config);
  const sessionId = began.value.sessionId;

  // From here the session is `uploading`: any exit that is not `offered` returns it to `claimed` and purges.
  const abandon = async (error: ErrorCode, r2Key: string | null): Promise<Response> => {
    try {
      if (r2Key) await drop.delete(r2Key);
      await drop.purge(sessionId, r2Key);
    } catch {
      console.error("guest_delete_failed");
    }
    await stub.dropFailed(credential, error);
    return fail(error);
  };

  let reserved: Awaited<ReturnType<typeof drop.reserve>>;
  try {
    reserved = await drop.reserve(sessionId, length, file.name, file.type);
  } catch {
    return abandon("internal", null);
  }
  if (!reserved.ok) return abandon(reserved.error, null);
  const { r2Key } = reserved;
  let accepted: Awaited<ReturnType<typeof drop.accept>>;
  try {
    accepted = await drop.accept(
      { sessionKey: sessionId, r2Key, name: file.name, declaredType: file.type, length, body: request.body },
      config.guestMaxBytes,
    );
  } catch {
    return abandon("upload_aborted", r2Key);
  }
  if (!accepted.ok) return abandon(accepted.error, r2Key);

  const offered = await stub.dropDone(credential, {
    source: "guest",
    ref: accepted.file.r2Key,
    name: accepted.file.name,
    type: accepted.file.type,
    size: accepted.file.bytes,
  });
  // The session ended or was canceled while the bytes were arriving: nothing may keep them.
  if (!offered.ok) return abandon(offered.error, r2Key);
  return json(offered.value);
}

export const dropRoutes: readonly Route[] = [route(["PUT"], "/api/drop", "api", withConfig(putDrop))];
