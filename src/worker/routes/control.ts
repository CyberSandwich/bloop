// The phone's session controls. The remote: the phone commands what the screen shows (`POST /api/control`, pid), and
// the screen reports its own taps so the phone's highlight stays true (`POST /api/screen/shown`, sid), demo sessions
// only. The length: the phone sets when the session ends (`POST /api/session/length`, pid), in both modes. The live
// pick: the phone's choice of the number on the screen (`POST /api/match`, pid).
// Order: config, CSRF checks (PAIR-06), the per-IP rate limit, the capped body and Zod, the per-credential rate limit,
// one Screen object call.
import { z } from "zod";
import { MIN_LENGTH_SECONDS } from "../../../public/js/shared/length.js";
import type { ShownCommand } from "../../shared/protocol.ts";
import type { Config } from "../config.ts";
import { checkWrite, json, readJson } from "../http.ts";
import { idempotency } from "../idem.ts";
import { sha256Hex } from "../ids.ts";
import { shownSchema } from "../items.ts";
import { type Route, route } from "../router.ts";
import type { Result } from "../seams/pairing.ts";
import type { screenStub } from "../stubs.ts";
import { limited, withConfig, withScreen } from "./common.ts";

const commandBody = z
  .object({
    ...shownSchema.shape,
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    base: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

/** The live pick (PAIR-14). */
const matchBody = z.object({ choice: z.string().regex(/^\d{2}$/) }).strict();

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

type Call<B, T> = (
  stub: ReturnType<typeof screenStub>,
  credential: string,
  body: B,
  sent: { request: Request; text: string },
) => Promise<Result<T>>;

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
      // The CSRF checks and the per-IP limit before the body is read, so a refused request costs no read.
      const refused = checkWrite(request, config.origin) ?? (await limited(env, "RL_CONTROL", request, config));
      if (refused) return refused;
      const parsed = await readJson(request, body(config));
      if (!parsed.ok) return parsed.response;
      const { text } = parsed;
      return withScreen(
        request,
        env,
        async (stub, credential): Promise<Result<T>> =>
          (await limited(env, "RL_CONTROL", request, config, await sha256Hex(credential)))
            ? { ok: false, error: "rate_limited" }
            : call(stub, credential, parsed.value, { request, text }),
        (view) => json(view),
      );
    }),
  );

const command = () => commandBody;

export const controlRoutes: readonly Route[] = [
  control("/api/control", command, (stub, pid, c: ShownCommand) => stub.control(pid, c)),
  control("/api/screen/shown", command, (stub, sid, c: ShownCommand) => stub.reportShown(sid, c)),
  control("/api/session/length", lengthBody, (stub, pid, { seconds }) => stub.setLength(pid, seconds)),
  control(
    "/api/match",
    () => matchBody,
    async (stub, pid, { choice }, { request, text }) => {
      // A retried pick answers as the first did (REL-14); the Screen scopes the key to this pairing.
      const idem = await idempotency(request, text, "pairing", {
        find: (_owner, keyHash, since) => stub.matchIdemFind(pid, keyHash, since),
      });
      if (idem.kind === "bad" || idem.kind === "conflict") return { ok: false, error: "bad_request" };
      if (idem.kind === "replay") return { ok: true, value: idem.stored };
      const fresh = idem.kind === "fresh" ? { keyHash: idem.keyHash, bodyHash: idem.bodyHash } : undefined;
      return stub.match(pid, choice, fresh);
    },
  ),
];
