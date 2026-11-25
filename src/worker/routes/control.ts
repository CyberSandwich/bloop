// The remote: the phone commands what the screen shows (`POST /api/control`, pid), and the screen reports its own taps
// so the phone's highlight stays true (`POST /api/screen/shown`, sid). One body, one machine event, demo sessions only.
// Order: config, CSRF checks and Zod (`write`, PAIR-06), the per-IP and then the per-credential rate limit, one Screen
// object call.
import { z } from "zod";
import type { ShownCommand } from "../../shared/protocol.ts";
import { json } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import { shownSchema } from "../items.ts";
import { type Route, route } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import type { screenStub } from "../stubs.ts";
import { limited, withConfig, withScreen, write } from "./common.ts";

const commandBody = z
  .object({ ...shownSchema.shape, seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict();

type Call<T> = (stub: ReturnType<typeof screenStub>, credential: string, command: ShownCommand) => Promise<Result<T>>;

/**
 * One remote write. `RL_CONTROL` is the remote's own binding, so a video's range reads on `/f/` (`RL_FETCH`) never
 * refuse a tap behind the same address. Per IP it bounds a stranger, then per credential one session (PAIR-13). The
 * second key is the credential's hash, not the screen ref: a ref is not secret (every `/f/` token carries it), so a ref
 * key would let anyone holding one of the screen's links spend its remote's budget.
 */
const remote = <T>(path: string, call: Call<T>): Route =>
  route(
    ["POST"],
    path,
    "api",
    withConfig(async (request, env, config) => {
      const body = await write(request, config, commandBody);
      if (!body.ok) return body.response;
      const tooMany = await limited(env.RL_CONTROL, request, config);
      if (tooMany) return tooMany;
      return withScreen(
        request,
        env,
        async (stub, credential): Promise<Result<T>> =>
          (await limited(env.RL_CONTROL, request, config, await sha256Hex(credential)))
            ? { ok: false, error: "rate_limited" }
            : call(stub, credential, body.value),
        (view) => json(view),
      );
    }),
  );

export const controlRoutes: readonly Route[] = [
  remote("/api/control", (stub, pid, command) => stub.control(pid, command)),
  remote("/api/screen/shown", (stub, sid, command) => stub.reportShown(sid, command)),
];
