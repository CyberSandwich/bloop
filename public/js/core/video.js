// VID-04: moov location (`©xyz`, `loci`, location mdta keys) is blanked in place; `gps `, `XMP_`, text and timed-metadata
// tracks are refused (a `mebx` with no location key stays). Not covered: XMP in `uuid`, location in mdat samples.

const KEY_PREFIX = "com.apple.quicktime.location.";
const MAX_MOOV = 32 * 1024 * 1024;
const MAX_TOP_BOXES = 1000;

const u32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const fourcc = (/** @type {Uint8Array} */ b, /** @type {number} */ o) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
const unsupported = () => new Error("unsupported video structure");
/** @typedef {{body: number, end: number}} Box */

/** The box header at `o`, `left` bytes before its parent's end; size 0 runs to it. */
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

/** Where a `meta`'s boxes start (ISO has 4 bytes of version first); -1: no hdlr. */
const metaStart = (/** @type {Uint8Array} */ b, /** @type {Box} */ meta) =>
  fourcc(b, meta.body + 4) === "hdlr" ? meta.body : fourcc(b, meta.body + 8) === "hdlr" ? meta.body + 4 : -1;

/** The 1-based ilst indexes of location keys. */
function locationKeys(/** @type {Uint8Array} */ b, /** @type {Box} */ keys) {
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

const latin1 = (/** @type {Uint8Array} */ b, /** @type {Box} */ box) =>
  new TextDecoder("latin1").decode(b.subarray(box.body, box.end));

function blankMeta(/** @type {Uint8Array} */ b, /** @type {Box} */ meta, nested = true) {
  const start = metaStart(b, meta);
  // A meta with no hdlr to place its children by is skipped only if it names no `ilst` or `keys`.
  if (start < 0 && (!nested || /ilst|keys/.test(latin1(b, meta)))) throw unsupported();
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
      if (data.type !== "data" || data.end - data.body < 8) throw unsupported();
      b.fill(0, data.body + 8, data.end);
      n++;
    }
  }
  return n;
}

const CONTAINERS = new Set(["trak", "mdia", "minf", "stbl", "udta"]);

const REFUSED = new Set(["gps ", "XMP_", "gpmd", "mett", "metx", "camm", "rtmd"]);

function refuseTimed(/** @type {Uint8Array} */ b, /** @type {Box} */ stsd, timed = false) {
  for (const e of children(b, stsd.body + 8, stsd.end)) {
    const mebx = e.type === "mebx";
    if ((mebx && latin1(b, e).includes(KEY_PREFIX)) || REFUSED.has(e.type) || (timed && !mebx)) throw unsupported();
  }
}

function walk(
  /** @type {Uint8Array} */ b,
  /** @type {number} */ from,
  /** @type {number} */ to,
  term = false,
  nested = false,
  timed = false,
) {
  let n = 0;
  for (const box of children(b, from, to, term)) {
    if (REFUSED.has(box.type)) throw unsupported();
    if (box.type === "©xyz" || box.type === "loci") {
      b.fill(0, box.body, box.end);
      n++;
    } else if (box.type === "meta") n += blankMeta(b, box, nested);
    else if (box.type === "stsd") refuseTimed(b, box, timed);
    else if (CONTAINERS.has(box.type)) {
      n += walk(
        b,
        box.body,
        box.end,
        box.type === "udta",
        true,
        timed || (box.type === "mdia" && /hdlr[\s\S]{8}(meta|sbtl|text|subt)/.test(latin1(b, box))),
      );
    }
  }
  return n;
}

/** Blanks `moov` in place: the count, or throws. @param {Uint8Array} moov */
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
 * The file with its location blanked, or `{ok: false}`.
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
