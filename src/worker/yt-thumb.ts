// The one upstream the Worker fetches for a page: a YouTube video's thumbnail, served from this origin as a link item's
// preview (ADR 0009, PREVIEW-01). Pure, so the unit tests run it with a fake fetch.

/** A link item's `preview`: a same-origin path of this one shape, never an absolute or third-party URL. */
const ID = "[A-Za-z0-9_-]{11}";
export const PREVIEW_PATH = new RegExp(`^/yt/(${ID})\\.jpg$`);

/** The video id inside a preview path, or null for anything else. */
export const previewId = (path: string): string | null => PREVIEW_PATH.exec(path)?.[1] ?? null;

/** The preview path of a video id. */
export const previewPath = (id: string): string => `/yt/${id}.jpg`;

/** The only host a thumbnail comes from, over https. */
export const THUMB_ORIGIN = "https://i.ytimg.com";
/** A larger picture is refused, never buffered past it. */
export const MAX_THUMB_BYTES = 200_000;
export const THUMB_TIMEOUT_MS = 5000;

/** The upstream URL of an id that passed `previewId`, built from the id alone; null for any other string. */
export function upstreamUrl(id: string, origin: string = THUMB_ORIGIN): string | null {
  return new RegExp(`^${ID}$`).test(id) ? `${origin}/vi/${id}/hqdefault.jpg` : null;
}

export type Thumb = { ok: true; bytes: Uint8Array } | { ok: false };
const FAILED: Thumb = { ok: false };

/** Reads at most `max` bytes; null when the stream is longer or fails (the rest is cancelled). */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * The thumbnail of `id`, or a failure for anything else: a bad id (no request is made), a throw or timeout, a redirect
 * or any status but 200, a type other than image/jpeg, a body over the cap, or bytes that do not start as a JPEG. The
 * request carries no cookie, referrer or client header, and never follows a redirect. A failure says nothing about why.
 */
export async function fetchThumb(
  id: string,
  fetcher: typeof fetch,
  origin: string = THUMB_ORIGIN,
  timeoutMs: number = THUMB_TIMEOUT_MS,
  max: number = MAX_THUMB_BYTES,
): Promise<Thumb> {
  const url = upstreamUrl(id, origin);
  if (!url) return FAILED;
  try {
    const res = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      // No Cookie or Referer: a Worker's fetch adds neither, and none is set here.
      headers: { Accept: "image/jpeg", "User-Agent": "bloop-thumb" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const type = (res.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
    const length = Number(res.headers.get("Content-Length") ?? 0);
    if (res.status !== 200 || type !== "image/jpeg" || !res.body || length > max) {
      await res.body?.cancel().catch(() => {});
      return FAILED;
    }
    const bytes = await readCapped(res.body, max);
    return bytes && isJpeg(bytes) ? { ok: true, bytes } : FAILED;
  } catch {
    return FAILED;
  }
}

/** What the route needs of a Cache, so this module stays free of Worker types. */
export interface CacheLike {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}
type Picture = Uint8Array | ArrayBuffer;

/**
 * The picture from the cache, else from `load`, which is then kept as `keep` shapes it. A cache that throws is a
 * miss and a failed put is dropped: the answer is a fresh fetch or null (the route's 404), never a 500.
 */
export async function throughCache(
  cache: CacheLike,
  key: Request,
  load: () => Promise<Picture | null>,
  keep: (bytes: Picture) => Response,
  defer: (work: Promise<unknown>) => void,
): Promise<Picture | null> {
  const hit = await cache.match(key).then(
    (r) => r?.arrayBuffer(),
    () => undefined,
  );
  if (hit) return hit;
  const bytes = await load();
  if (bytes)
    defer(
      Promise.resolve()
        .then(() => cache.put(key, keep(bytes)))
        .catch(() => {}),
    );
  return bytes;
}
