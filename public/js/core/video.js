// A video's location is blanked on the phone before it is sent (VID-04): the iPhone's mdta key
// com.apple.quicktime.location.* with its ilst value, and the `©xyz` atom Android and iPhone keep in moov/udta.
// Only values are overwritten, never lengths, so no offset in the file moves. A structure it cannot walk is refused.

const KEY_PREFIX = "com.apple.quicktime.location.";
const MAX_MOOV = 32 * 1024 * 1024;
const MAX_TOP_BOXES = 1000;

const u32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const fourcc = (/** @type {Uint8Array} */ b, /** @type {number} */ o) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
const unsupported = () => new Error("unsupported video structure");

/**
 * The box header at `o`, with `left` bytes to its parent's end. A size of 0 runs to that end; a 64-bit size must fit 32 bits.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} left
 */
function header(b, o, left) {
  if (left < 8) throw unsupported();
  let size = u32(b, o);
  let head = 8;
  if (size === 1) {
    if (left < 16 || u32(b, o + 8) !== 0) throw unsupported();
    size = u32(b, o + 12);
    head = 16;
  } else if (size === 0) size = left;
  if (size < head || size > left) throw unsupported();
  return { type: fourcc(b, o + 4), head, size };
}

/**
 * QuickTime lets a `udta` end with a 32-bit zero instead of a box; `terminated` accepts exactly that.
 * @param {Uint8Array} b @param {number} from @param {number} to @param {boolean} [terminated]
 */
function* children(b, from, to, terminated = false) {
  for (let at = from; at < to; ) {
    if (terminated && to - at === 4 && u32(b, at) === 0) return;
    const h = header(b, at, to - at);
    yield { type: h.type, at, body: at + h.head, end: at + h.size };
    at += h.size;
  }
}

/**
 * The boxes of a `meta` start after its hdlr: directly (QuickTime) or after four version and flag bytes (ISO).
 * @param {Uint8Array} b
 * @param {{body: number}} meta
 */
function metaStart(b, meta) {
  if (fourcc(b, meta.body + 4) === "hdlr") return meta.body;
  if (fourcc(b, meta.body + 8) === "hdlr") return meta.body + 4;
  throw unsupported();
}

/** The ilst indexes (1-based) of the keys that hold a location. */
function locationKeys(/** @type {Uint8Array} */ b, /** @type {{body: number, end: number}} */ keys) {
  const found = new Set();
  const count = u32(b, keys.body + 4);
  let at = keys.body + 8;
  for (let i = 1; i <= count; i++) {
    if (at + 8 > keys.end) throw unsupported();
    const size = u32(b, at);
    if (size < 8 || at + size > keys.end) throw unsupported();
    const name = String.fromCharCode(...b.subarray(at + 8, at + size));
    if (name.startsWith(KEY_PREFIX)) found.add(i);
    at += size;
  }
  return found;
}

/** @returns {number} how many values were blanked */
function blankMeta(/** @type {Uint8Array} */ b, /** @type {{body: number, end: number}} */ meta) {
  const kids = [...children(b, metaStart(b, meta), meta.end)];
  const keys = kids.find((k) => k.type === "keys");
  const ilst = kids.find((k) => k.type === "ilst");
  if (!keys || !ilst) return 0;
  const wanted = locationKeys(b, keys);
  let n = 0;
  for (const item of children(b, ilst.body, ilst.end)) {
    if (!wanted.has(u32(b, item.at + 4))) continue;
    for (const data of children(b, item.body, item.end)) {
      // 8 bytes of type indicator and locale precede the value.
      if (data.type !== "data" || data.end - data.body < 8) throw unsupported();
      b.fill(0, data.body + 8, data.end);
      n++;
    }
  }
  return n;
}

/**
 * Blanks the locations inside a whole `moov` box, in place.
 * @param {Uint8Array} moov
 * @returns {number} how many were blanked; throws on a structure it cannot walk
 */
export function blankLocation(moov) {
  const h = header(moov, 0, moov.length);
  if (h.type !== "moov" || h.size !== moov.length) throw unsupported();
  let n = 0;
  for (const box of children(moov, h.head, h.size)) {
    if (box.type === "meta") n += blankMeta(moov, box);
    if (box.type !== "udta") continue;
    for (const atom of children(moov, box.body, box.end, true)) {
      if (atom.type !== "©xyz") continue;
      moov.fill(0, atom.body, atom.end);
      n++;
    }
  }
  return n;
}

/** The top-level `moov`, found by reading box headers only. @param {Blob} file */
async function findMoov(file) {
  for (let at = 0, seen = 0; at < file.size && seen++ < MAX_TOP_BOXES; ) {
    const head = new Uint8Array(await file.slice(at, at + 16).arrayBuffer());
    const h = header(head, 0, file.size - at);
    if (h.type === "moov") return { at, size: h.size };
    at += h.size;
  }
  throw unsupported();
}

/**
 * The file with its location blanked, or `{ok: false}` when its structure is not understood. A file with no location is
 * returned as it is.
 * @param {File} file
 * @returns {Promise<{ok: true, file: File} | {ok: false}>}
 */
export async function stripLocation(file) {
  try {
    const { at, size } = await findMoov(file);
    if (size > MAX_MOOV) throw unsupported();
    const moov = new Uint8Array(await file.slice(at, at + size).arrayBuffer());
    if (blankLocation(moov) === 0) return { ok: true, file };
    const parts = [file.slice(0, at), moov, file.slice(at + size)];
    return { ok: true, file: new File(parts, file.name, { type: file.type }) };
  } catch {
    return { ok: false };
  }
}
