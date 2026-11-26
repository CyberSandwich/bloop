// The dev mailbox: GET /api/dev/mailbox?to= lists the mail kept in memory, DELETE clears it. Both answer not_found
// unless DEV_MAILBOX=1, which config refuses on a non-local origin.
import { clearDevMailbox, readDevMailbox } from "../auth/email.ts";
import { checkOrigin, fail, json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { withConfig } from "./common.ts";

export const devMailRoutes: readonly Route[] = [
  route(
    ["GET"],
    "/api/dev/mailbox",
    "api",
    withConfig((request, _env, config) => {
      if (!config.account.devMailbox) return fail("not_found");
      return json(readDevMailbox(new URL(request.url).searchParams.get("to") ?? undefined));
    }),
  ),
  route(
    ["DELETE"],
    "/api/dev/mailbox",
    "api",
    withConfig((request, _env, config) => {
      if (!config.account.devMailbox) return fail("not_found");
      const refused = checkOrigin(request, config.origin);
      if (refused) return refused;
      clearDevMailbox();
      return new Response(null, { status: 204 });
    }),
  ),
];
