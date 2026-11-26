// The phone's session controls. The remote: the phone commands what the screen shows (`POST /api/control`, pid), and
// the screen reports its own taps so the phone's highlight stays true (`POST /api/screen/shown`, sid), demo sessions
// only. The length: the phone sets when the session ends (`POST /api/session/length`, pid), in both modes.
// Order: config, CSRF checks and Zod (`write`, PAIR-06), the per-IP and then the per-credential rate limit, one Screen
// object call.
import { z } from "zod";
import { MIN_LENGTH_SECONDS } from "../../../public/js/shared/length.js";
import type { ShownCommand } from "../../shared/protocol.ts";
import type { Config } from "../config.ts";
import { json } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import { shownSchema } from "../items.ts";
import { type Route, route } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import type { screenStub } from "../stubs.ts";
import { limited, withConfig, withScreen, write } from "./common.ts";

const commandBody = z
  .object({
    ...shownSchema.shape,
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    base: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

/** Up to the live cap, the larger one: the Screen object clamps a demo session to its own. */
const lengthBody = (config: Config) =>
  z
    .object({
      seconds: z
        .number()
        .int()
        .min(MIN_LENGTH_SECONDS)
        .max(config.sessionMaxMinutes * 60),
    })
    .strict();

type Call<B, T> = (stub: ReturnType<typeof screenStub>, credential: string, body: B) => Promise<Result<T>>;

/**
 * One session write from a credential holder. `RL_CONTROL` is the controls' own binding, so a video's range reads on
 * `/f/` (`RL_FETCH`) never refuse a tap behind the same address. Per IP it bounds a stranger, then per credential one
 * session (PAIR-13, SESS-01). The second key is the credential's hash, not the screen ref: a ref is not secret (every
 * `/f/` token carries it), so a ref key would let anyone holding one of the screen's links spend its budget.
 */
const control = <B, T>(path: string, body: (config: Config) => z.ZodType<B>, call: Call<B, T>): Route =>
  route(
    ["POST"],
    path,
    "api",
    withConfig(async (request, env, config) => {
      const parsed = await write(request, config, body(config));
      if (!parsed.ok) return parsed.response;
      const tooMany = await limited(env, "RL_CONTROL", request, config);
      if (tooMany) return tooMany;
      return withScreen(
        request,
        env,
        async (stub, credential): Promise<Result<T>> =>
          (await limited(env, "RL_CONTROL", request, config, await sha256Hex(credential)))
            ? { ok: false, error: "rate_limited" }
            : call(stub, credential, parsed.value),
        (view) => json(view),
      );
    }),
  );

const command = () => commandBody;

export const controlRoutes: readonly Route[] = [
  control("/api/control", command, (stub, pid, c: ShownCommand) => stub.control(pid, c)),
  control("/api/screen/shown", command, (stub, sid, c: ShownCommand) => stub.reportShown(sid, c)),
  control("/api/session/length", lengthBody, (stub, pid, { seconds }) => stub.setLength(pid, seconds)),
];
