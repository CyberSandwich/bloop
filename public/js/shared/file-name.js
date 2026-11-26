// The stored file name: how a name is cleaned and cut, and when a typed one is acceptable. Shared by the browser's
// upload engine (it fingerprints the name as the server keeps it) and the Worker (the one rule, docs/uploads.md).
/** Longest stored file name, in code points, extension included. Display length is CSS ellipsis, never a cut. */
export const NAME_MAX = 200;

/**
 * The refused characters: every control, format, unassigned and private-use character (bidi overrides, soft hyphens,
 * invisible operators and annotation marks among them) and the Hangul fillers, which draw blank. The joiners emoji and
 * Persian need (ZWJ, ZWNJ) and the tag characters of a subdivision flag are the exceptions `tidy` places. Only the `u`
 * flag, no `v` and no lookbehind: this module loads on the browser floor (design.md), where one of them throws.
 */
const REFUSED = /[\p{C}\u115F\u1160\u3164\uFFA0]/gu;
/** A subdivision flag (a black flag, its tag letters, the cancel tag) as one unit, else one code point. */
const UNITS = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|[\s\S]/gu;

/** @param {string} text */
const len = (text) => Array.from(text).length;

/** @param {number} code */
const isJoiner = (code) => code === 0x200c || code === 0x200d;
/** @param {number} code */
const isTag = (code) => code >= 0xe0020 && code <= 0xe007f;
/** @param {number} code */
const isHidden = (code) => isJoiner(code) || isTag(code);

/**
 * Whether a unit draws something: not white space, a joiner or a tag character.
 * @param {string} unit
 */
const visible = (unit) => {
  const code = unit.codePointAt(0) ?? 0;
  return !/^\s/u.test(unit) && !isJoiner(code) && !isTag(code);
};

/**
 * Keeps a joiner only between two visible characters and a tag character only inside a flag, so no name is made of
 * hidden characters or carries hidden text.
 * @param {string} text
 */
function tidy(text) {
  const units = text.match(UNITS) ?? [];
  /** @type {string[]} */
  const out = [];
  units.forEach((unit, i) => {
    const code = unit.codePointAt(0) ?? 0;
    if (isTag(code)) return;
    const next = units[i + 1];
    if (
      !isJoiner(code) ||
      (out.length > 0 && visible(out[out.length - 1] ?? "") && next !== undefined && visible(next))
    )
      out.push(unit);
  });
  return out.join("");
}

/**
 * A file name safe to show and store, and stable: cleaning it again changes nothing. Refused characters removed,
 * joiners and tag characters placed by `tidy`, path separators turned into hyphens, spaces collapsed, NFC, cut to
 * `max` code points with the extension kept (a flag is never split, no trailing space is left).
 * It is still untrusted text: pages set it with textContent only.
 * @param {string} raw
 * @param {number} [max]
 * @returns {string} empty when nothing printable is left
 */
export function cleanName(raw, max = NAME_MAX) {
  const name = tidy(raw.normalize("NFC").replace(REFUSED, (c) => (isHidden(c.codePointAt(0) ?? 0) ? c : "")))
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  if (len(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const ext = len(tail) < max ? tail : "";
  let room = max - len(ext);
  const kept = [];
  for (const unit of name.slice(0, ext ? dot : name.length).match(UNITS) ?? []) {
    room -= len(unit);
    if (room < 0) break;
    kept.push(unit);
  }
  return `${tidy(kept.join("")).trimEnd()}${ext}`.normalize("NFC");
}

/**
 * A typed name is refused, never cut: 1 to NAME_MAX code points and exactly what `cleanName` would keep, so a rename
 * cannot store a name the upload path would not (NFD, doubled spaces, stray joiners).
 * @param {string} name
 */
export const isValidName = (name) =>
  name !== "" && len(name) <= NAME_MAX && cleanName(name, Number.POSITIVE_INFINITY) === name;
