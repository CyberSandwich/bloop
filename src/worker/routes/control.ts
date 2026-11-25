// The remote: the phone commands what the screen shows (`POST /api/control`, pid), and the screen reports its own taps
// so the phone's highlight stays true (`POST /api/screen/shown`, sid). One body, one machine event, demo sessions only.
// Order: config, CSRF checks and Zod (`write`, PAIR-06), the per-IP and then the per-credential rate limit, one Screen
// object call.
import { z } from "zod";
import type { Shown } from "../../shared/protocol.ts";
import { json } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import { type Route, route } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import type { screenStub } from "../stubs.ts";
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

type Call<T> = (stub: ReturnType<typeof screenStub>, credential: string, shown: Shown) => Promise<Result<T>>;

/**
 * One remote write. `RL_FETCH` per IP bounds a stranger, then per credential bounds one session (PAIR-13). The second
 * key is the credential's hash, not the screen ref: a ref is not secret (every `/f/` token carries it), so a ref key
 * would let anyone holding one of the screen's links spend its remote's budget.
 */
const remote = <T>(path: string, call: Call<T>): Route =>
  route(
    ["POST"],
    path,
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, shownBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env.RL_FETCH, request, config);
      if (tooMany) return tooMany;
      return withScreen(
        request,
        env,
        async (stub, credential): Promise<Result<T>> =>
          (await limited(env.RL_FETCH, request, config, await sha256Hex(credential)))
            ? { ok: false, error: "rate_limited" }
            : call(stub, credential, body.value),
        (view) => json(view),
      );
    }),
  );

export const controlRoutes: readonly Route[] = [
  remote("/api/control", (stub, pid, shown) => stub.control(pid, shown)),
  remote("/api/screen/shown", (stub, sid, shown) => stub.reportShown(sid, shown)),
];
