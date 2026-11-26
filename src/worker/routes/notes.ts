// Speaker notes for the phone: `GET /api/notes?item=<id>`, Bearer pid only (ADR 0015, NOTES-01). The item id is looked up
// in the Screen object's own session list and the source is asked for that file's notes; the answer is JSON under the
// `api` policy (`no-store`). Never a link, never in a view or a frame.
import { z } from "zod";
import { fail, json } from "../http.ts";
import { sha256Hex } from "../ids.ts";
import { type Route, route } from "../router.ts";
import { accessForUser } from "../source-access.ts";
import { limited, screenFor, withConfig } from "./common.ts";

const itemId = z.string().min(1).max(32);

export const noteRoutes: readonly Route[] = [
  route(
    ["GET"],
    "/api/notes",
    "api",
    withConfig(async (request, env, config) => {
      const tooMany = await limited(env, "RL_CONTROL", request, config);
      if (tooMany) return tooMany;
      const screen = screenFor(request, env);
      if (!screen) return fail("unauthorized");
      const id = itemId.safeParse(new URL(request.url).searchParams.get("item"));
      if (!id.success) return fail("bad_request");
      if (await limited(env, "RL_CONTROL", request, config, await sha256Hex(screen.credential))) {
        return fail("rate_limited");
      }
      const found = await screen.stub.noteItem(screen.credential, id.data);
      if (!found.ok) return fail(found.error);
      const { file, mode, userId } = found.value;
      // Only the demo source has notes today; a link, a guest file or a live Graph file has none.
      if (file?.source !== "mock") return json({ notes: [] });
      const access = await accessForUser(env, config, mode, userId);
      if (!access.ok) return access.response;
      const notes = (await access.source.notes?.(access.ctx, file.ref)) ?? { ok: true, notes: [] };
      return notes.ok ? json({ notes: notes.notes }) : fail(notes.error);
    }),
  ),
];
