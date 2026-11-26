// A link item's preview picture, `GET /yt/<id>.jpg` (ADR 0009, PREVIEW-01). Only the ids of the demo catalog's own
// videos are served, each fetched from the one upstream host with a fixed request (`fetchThumb`) and kept in this
// data center's cache, so a page load never reaches YouTube. Any failure is a plain 404 that is never cached: the row
// then shows its link glyph.

import { withPolicy } from "../headers.ts";
import { problem } from "../http.ts";
import { type Route, route } from "../router.ts";
import { DEMO_THUMB_IDS } from "../seams/file-source/demo.ts";
import { fetchThumb, previewId, previewPath } from "../yt-thumb.ts";
import { limited, withConfig } from "./common.ts";

/** One day, in the browser and the shared cache alike. */
const MAX_AGE_SECONDS = 86_400;

const image = (bytes: BodyInit): Response =>
  withPolicy(
    new Response(bytes, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}`,
        "X-Content-Type-Options": "nosniff",
      },
    }),
    "thumb",
  );

/** A failure under the `api` policy, whose `no-store` keeps it out of every cache. */
const notFound = (): Response => withPolicy(problem(404, "not_found"), "api");

export const thumbRoutes: readonly Route[] = [
  route(
    ["GET"],
    "/yt/:file",
    "thumb",
    withConfig(async (request, env, config, ctx) => {
      const tooMany = await limited(env, "RL_FETCH", request, config);
      if (tooMany) return tooMany;
      const id = previewId(new URL(request.url).pathname);
      if (!id || !DEMO_THUMB_IDS.has(id)) return notFound();
      // Keyed by the validated id alone, so nothing a request carries can pick or poison the entry.
      const key = new Request(new URL(previewPath(id), config.origin));
      const cached = await caches.default.match(key);
      if (cached) return image(await cached.arrayBuffer());
      const thumb = await fetchThumb(id, (input, init) => fetch(input, init), config.thumbOrigin);
      if (!thumb.ok) return notFound();
      const good = image(thumb.bytes);
      ctx.waitUntil(caches.default.put(key, good.clone()));
      return good;
    }),
  ),
];
