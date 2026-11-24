// The remote: the phone commands what the screen shows (`POST /api/control`, pid), and the screen reports its own taps
// so the phone's highlight stays true (`POST /api/screen/shown`, sid). One body, one machine event, demo sessions only.
// Order as every write: config, CSRF checks (PAIR-06), platform rate limit, Zod, one Screen object call.
import { z } from "zod";
import { json } from "../http.ts";
import { type Route, route } from "../router.ts";
import { limited, withConfig, withScreen, write } from "./common.ts";

/** A bound, not a page count: the machine checks the item's real pages. */
const MAX_PAGE = 1000;

const shownBody = z
  .object({
    item: z.string().min(1).max(32),
    page: z.number().int().min(1).max(MAX_PAGE),
    present: z.boolean(),
  })
  .strict();

export const controlRoutes: readonly Route[] = [
  route(
    ["POST"],
    "/api/control",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, shownBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env.RL_FETCH, request, config);
      if (tooMany) return tooMany;
      return withScreen(
        request,
        env,
        (stub, pid) => stub.control(pid, body.value),
        (view) => json(view),
      );
    }),
  ),

  route(
    ["POST"],
    "/api/screen/shown",
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, shownBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env.RL_FETCH, request, config);
      if (tooMany) return tooMany;
      return withScreen(
        request,
        env,
        (stub, sid) => stub.reportShown(sid, body.value),
        (view) => json(view),
      );
    }),
  ),
];
