// The file-origin host's own routes (ADR 0018). Today only the probe: the app asks FILE_ORIGIN/fo/ping and falls back
// to minting links on PUBLIC_ORIGIN when it does not answer in time (FO-01). The present-server change adds /f/, /b/
// and /p/ here. The host never reads or sets a cookie: origin.ts sends everything else to PUBLIC_ORIGIN.
import { withPolicy } from "../headers.ts";
import { fail } from "../http.ts";
import { type Route, route } from "../router.ts";
import { withConfig } from "./common.ts";

export const fileOriginRoutes: readonly Route[] = [
  route(
    ["GET", "HEAD"],
    "/fo/ping",
    "file-origin",
    withConfig((request, _env, config) =>
      // Only the file host answers; on PUBLIC_ORIGIN the path is as unknown as any other.
      new URL(request.url).origin === config.library.fileOrigin
        ? new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": config.origin, Vary: "Origin" } })
        : withPolicy(fail("not_found"), "api"),
    ),
  ),
];
