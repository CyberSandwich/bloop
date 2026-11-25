// VID-04: in moov, at any depth, values are blanked (no offset moves) for `©xyz`, `loci`, location mdta keys and a
// keyless ilst `©xyz`; a `gpmd` or location-keyed `mebx` track is refused. Not covered: XMP in a `uuid` box.

const KEY_PREFIX = "com.apple.quicktime.location.";
const MAX_MOOV = 32 * 1024 * 1024;
const MAX_TOP_BOXES = 1000;

const u32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const fourcc = (/** @type {Uint8Array} */ b, /** @type {number} */ o) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
const unsupported = () => new Error("unsupported video structure");
/** @typedef {{body: number, end: number}} Box */

/** The box header at `o`, `left` bytes before its parent's end. Size 0 runs to that end; 64-bit sizes must fit 32. */
function header(/** @type {Uint8Array} */ b, /** @type {number} */ o, /** @type {number} */ left) {
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

/** `term`: a `udta` may end with QuickTime's 32-bit zero instead of a box. @param {Uint8Array} b @param {number} from @param {number} to @param {boolean} [term] */
function* children(b, from, to, term = false) {
  for (let at = from; at < to; ) {
    if (term && to - at === 4 && u32(b, at) === 0) return;
    const h = header(b, at, to - at);
    yield { type: h.type, at, body: at + h.head, end: at + h.size };
    at += h.size;
  }
}

/** Where a `meta`'s boxes start: QuickTime has no version and flags before the hdlr, ISO has four bytes. -1: no hdlr. */
const metaStart = (/** @type {Uint8Array} */ b, /** @type {Box} */ meta) =>
  fourcc(b, meta.body + 4) === "hdlr" ? meta.body : fourcc(b, meta.body + 8) === "hdlr" ? meta.body + 4 : -1;

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

function blankMeta(/** @type {Uint8Array} */ b, /** @type {Box} */ meta, nested = true) {
  const start = metaStart(b, meta);
  if (start < 0 && !nested) throw unsupported();
  if (start < 0) return 0;
  const kids = [...children(b, start, meta.end)];
  const keys = kids.find((k) => k.type === "keys");
  const ilst = kids.find((k) => k.type === "ilst");
  if (!ilst) return 0;
  const wanted = keys ? locationKeys(b, keys) : new Set();
  let n = 0;
  for (const item of children(b, ilst.body, ilst.end)) {
    if (item.type !== "©xyz" && !wanted.has(u32(b, item.at + 4))) continue;
    for (const data of children(b, item.body, item.end)) {
      // type indicator and locale: 8 bytes
      if (data.type !== "data" || data.end - data.body < 8) throw unsupported();
      b.fill(0, data.body + 8, data.end);
      n++;
    }
  }
  return n;
}

const CONTAINERS = new Set(["trak", "mdia", "minf", "stbl", "udta"]);

/** Timed metadata keeps its values in mdat, out of reach: refuse. */
function refuseTimed(/** @type {Uint8Array} */ b, /** @type {Box} */ stsd) {
  for (const e of children(b, stsd.body + 8, stsd.end)) {
    const keyed = e.type === "mebx" && new TextDecoder("latin1").decode(b.subarray(e.body, e.end)).includes(KEY_PREFIX);
    if (e.type === "gpmd" || keyed) throw unsupported();
  }
}

function walk(
  /** @type {Uint8Array} */ b,
  /** @type {number} */ from,
  /** @type {number} */ to,
  term = false,
  nested = false,
) {
  let n = 0;
  for (const box of children(b, from, to, term)) {
    if (box.type === "©xyz" || box.type === "loci") {
      b.fill(0, box.body, box.end);
      n++;
    } else if (box.type === "meta") n += blankMeta(b, box, nested);
    else if (box.type === "stsd") refuseTimed(b, box);
    else if (CONTAINERS.has(box.type)) n += walk(b, box.body, box.end, box.type === "udta", true);
  }
  return n;
}

/** Blanks a whole `moov` in place; returns how many, throws on a structure it cannot walk. @param {Uint8Array} moov */
export function blankLocation(moov) {
  const h = header(moov, 0, moov.length);
  if (h.type !== "moov" || h.size !== moov.length) throw unsupported();
  return walk(moov, h.head, h.size);
}

/** The top-level `moov`, by box headers only. @param {Blob} file */
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
 * The file with its location blanked (as it is when it has none), or `{ok: false}` when it cannot be.
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
