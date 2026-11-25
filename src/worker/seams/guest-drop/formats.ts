// Pure format checks for the wider guest-drop types (DROP-14, DROP-15): OOXML relationships and content types,
// magic bytes and brands, plain text. Nothing here reads storage; callers pass the bytes or text they already hold.
import type { DropError } from "../../../shared/protocol.ts";
import { ascii, majorBrand } from "./bytes.ts";
import { ZIP_LIMITS } from "./index.ts";

/** The verdict shape shared by cfb.ts, pdf-scan.ts and this file; `reason` names the rule for logs and tests. */
export type Check = { ok: true } | { ok: false; error: DropError; reason: string };
export const OK: Check = { ok: true };
export const fail = (error: DropError, reason: string): Check => ({ ok: false, error, reason });

/** A relationships part, in any folder: the wiring passes every part whose name matches. */
export const isRelsPart = (name: string): boolean => /(^|\/)_rels\/[^/]*\.rels$/i.test(name);

/** An XML part as text, or null when it is UTF-16 (a byte order mark), not valid UTF-8, or declares another encoding. */
export function decodeXml(bytes: Uint8Array): string | null {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const declared = /^\uFEFF?<\?xml[^>]*\sencoding\s*=\s*["']([^"']*)["']/i.exec(text)?.[1];
  return declared === undefined || /^utf-8$/i.test(declared) ? text : null;
}

type Attrs = ReadonlyMap<string, string>;
const ATTR = /\s*([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAIL = /\s*\/?\s*$/y;
const SKIPPED = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<?", "?>"],
] as const;

/** The attributes of one start tag's text after its name, keyed in lower case; null when malformed or one repeats. */
function attributes(rest: string): Attrs | null {
  const out = new Map<string, string>();
  let at = 0;
  for (;;) {
    ATTR.lastIndex = at;
    const m = ATTR.exec(rest);
    if (!m) break;
    const key = (m[1] as string).toLowerCase();
    if (out.has(key)) return null;
    out.set(key, (m[2] ?? m[3]) as string);
    at = ATTR.lastIndex;
  }
  TAIL.lastIndex = at;
  return TAIL.test(rest) ? out : null;
}

/** Where a comment, CDATA section or processing instruction at `i` ends; null when unterminated; undefined when none. */
function skipMarkup(xml: string, i: number): number | null | undefined {
  for (const [open, close] of SKIPPED) {
    if (!xml.startsWith(open, i)) continue;
    const end = xml.indexOf(close, i + open.length);
    return end === -1 ? null : end + close.length;
  }
  return undefined;
}

/**
 * The attributes of every element with the local name `local` (a namespace prefix is ignored), or null when the XML
 * is not plain: a DOCTYPE (entities), an unterminated tag or comment, a malformed attribute. Quotes are honored, so a
 * `>` or a look-alike attribute inside a value is data. One pass, linear in the text.
 */
function elements(xml: string, local: string): Attrs[] | null {
  const out: Attrs[] = [];
  for (let i = xml.indexOf("<"); i !== -1; i = xml.indexOf("<", i)) {
    const past = skipMarkup(xml, i);
    if (past === null || (past === undefined && xml.startsWith("<!", i))) return null;
    if (past !== undefined) {
      i = past;
      continue;
    }
    let quote = "";
    let j = i + 1;
    for (; j < xml.length; j++) {
      const c = xml[j] as string;
      if (quote) quote = c === quote ? "" : quote;
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= xml.length) return null;
    const tag = /^(?:[\w.-]+:)?([\w.-]+)/.exec(xml.slice(i + 1, j));
    if (tag?.[1] === local) {
      const attrs = attributes(xml.slice(i + 1 + tag[0].length, j));
      if (!attrs) return null;
      out.push(attrs);
    }
    i = j + 1;
  }
  return out;
}

/** A macro project or ActiveX control relationship, internal or not. */
const REFUSED_REL_TYPE = /\/(vbaProject\w*|activeXControl\w*|control|oleObject)$/i;
/** The only relationship types that may leave the package: a link the reader clicks, never one a converter follows. */
const HYPERLINK_TYPES: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink",
]);

export interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

/** Every relationship in one `.rels` part, or null when the part is not plain XML or hides a value behind an entity. */
export function relationships(relsXml: string): Relationship[] | null {
  const found = elements(relsXml, "Relationship");
  if (!found) return null;
  const out: Relationship[] = [];
  for (const a of found) {
    const [type, mode] = [a.get("type") ?? "", a.get("targetmode") ?? ""];
    if (type.includes("&") || mode.includes("&")) return null;
    out.push({ type, target: a.get("target") ?? "", external: mode.toLowerCase() === "external" });
  }
  return out;
}

/** The one `.bin` part Word and Excel write into ordinary files; every other `.bin` is refused. */
const PRINTER_SETTINGS = /(^|\/)printerSettings\/printerSettings\d+\.bin$/;

/** A macro, ActiveX or other binary part, in a docx, xlsx or pptx. */
export const isRefusedPart = (name: string): boolean =>
  !PRINTER_SETTINGS.test(name) && ZIP_LIMITS.refusedParts.some((p) => p.test(name));

/** Refuses a macro-enabled or VBA content type, and a content types part that is not plain XML or hides a value. */
function checkContentTypes(xml: string): Check {
  const entries = [elements(xml, "Default"), elements(xml, "Override")];
  if (entries.some((e) => e === null)) return fail("bad_structure", "content types");
  const values = entries.flatMap((e) => (e ?? []).map((a) => a.get("contenttype") ?? ""));
  if (values.some((v) => v.includes("&"))) return fail("bad_structure", "content types");
  if (ZIP_LIMITS.refusedContentTypes.some((p) => p.test(xml))) return fail("macro_content", "macro content type");
  return OK;
}

/**
 * An OOXML package (docx, xlsx, pptx and their macro twins) is refused when its content types name a macro-enabled
 * main part or a VBA project, when a macro or ActiveX part or relationship is present, or when a relationship other
 * than a hyperlink points outside the package. Judged on content, never on the extension: a `.docx` that carries a
 * docm content type is a docm.
 *
 * Wiring contract: `rels` holds the text (see `decodeXml`) of every part for which `isRelsPart(name)` is true; a
 * missing one is refused, so a partial list cannot pass.
 */
export function checkOoxml(
  names: readonly string[],
  contentTypesXml: string,
  rels: ReadonlyMap<string, string>,
): Check {
  // A `\` or `%` can spell a separator an extractor honors but `isRelsPart` does not see (`word\_rels\x.rels`).
  if (names.some((n) => /[\\%]/.test(n))) return fail("bad_structure", "entry name");
  // Two parts of one name: the reader may pick either, and only one was checked.
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return fail("bad_structure", "duplicate name");
  const types = checkContentTypes(contentTypesXml);
  if (!types.ok) return types;
  if (names.some(isRefusedPart)) return fail("macro_content", "macro part");
  for (const name of names.filter(isRelsPart)) {
    const text = rels.get(name);
    const parsed = text === undefined ? null : relationships(text);
    if (!parsed) return fail("bad_structure", "unreadable relationships");
    if (parsed.some((r) => REFUSED_REL_TYPE.test(r.type))) return fail("macro_content", "macro relationship");
    if (parsed.some((r) => r.external && !HYPERLINK_TYPES.has(r.type))) {
      return fail("bad_structure", "external relationship");
    }
  }
  return OK;
}

export type MediaKind = "webp" | "gif" | "heic" | "webm";

/** Major brands that open as HEIC or HEIF stills and sequences. */
const HEIC_BRANDS: ReadonlySet<string> = new Set([
  ...["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"],
  ...["mif1", "msf1"],
]);
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
/** The EBML header is a few dozen bytes; the DocType element sits inside it. */
const EBML_SCAN_BYTES = 64;
/** EBML DocType element (0x4282), a 4 byte value, then "webm". */
const WEBM_DOCTYPE = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];

const hasSequence = (b: Uint8Array, seq: number[], from = 0, to = b.length): boolean => {
  for (let i = from; i + seq.length <= to; i++) if (seq.every((s, j) => b[i + j] === s)) return true;
  return false;
};

/** What the first bytes say the file is, or null. WebM and Matroska share a header: only the `webm` DocType passes. */
export function detectMedia(head: Uint8Array): MediaKind | null {
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "webp";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "gif";
  const brand = majorBrand(head);
  if (brand !== null && HEIC_BRANDS.has(brand)) return "heic";
  if (EBML_MAGIC.every((m, i) => head[i] === m) && hasSequence(head, WEBM_DOCTYPE, 4, EBML_SCAN_BYTES)) return "webm";
  return null;
}

/** The detected format must equal the declared one. */
export const checkMagic = (head: Uint8Array, declared: MediaKind): Check =>
  detectMedia(head) === declared ? OK : fail("bad_type", "magic or brand mismatch");

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Plain text: at most 5 MB and valid UTF-8 (a leading byte order mark is allowed). */
export function checkText(bytes: Uint8Array): Check {
  if (bytes.length > MAX_TEXT_BYTES) return fail("too_large", "text over 5 MB");
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return OK;
  } catch {
    return fail("bad_type", "not UTF-8");
  }
}
