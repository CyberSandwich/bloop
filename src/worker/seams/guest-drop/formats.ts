// The one formats list (DROP-14, DROP-15): per type, the container family its first bytes must show and the part or
// stream that makes it that type, plus the pure checks over what a validator already holds: OOXML relationships and
// content types, magic bytes and brands, plain text. Nothing here reads storage.
import type { DropError, FileType, PlannedFileType } from "../../../shared/protocol.ts";
import { ascii, majorBrand, startsWith } from "./bytes.ts";
import { ZIP_LIMITS } from "./index.ts";

/** Every type the validators know. The library takes them all; a guest takes the six `FileType`s. */
export type FormatType = FileType | PlannedFileType;
/** A refusal code: a `DropError`, plus `encrypted` (a password protected file; the library's own copy). */
export type Refusal = DropError | "encrypted";
/** The code a guest's phone knows for a refusal: it has no copy for `encrypted`. */
export const dropError = (error: Refusal): DropError => (error === "encrypted" ? "bad_structure" : error);

/** What the first bytes say a file is. `zip` and `cfb` hold several types; the part or stream tells which. */
type Family = "zip" | "cfb" | "pdf" | "jpg" | "png" | "gif" | "webp" | "heic" | "mp4" | "mov" | "webm";
interface Format {
  /** Null for text, which has no magic. */
  family: Family | null;
  /** Zip: the part that makes the package this type. */
  part?: string;
  /** Compound file: the directory entries (lower case) of which the file must hold one. */
  streams?: readonly string[];
}
export const FORMATS: Record<FormatType, Format> = {
  pptx: { family: "zip", part: "ppt/presentation.xml" },
  docx: { family: "zip", part: "word/document.xml" },
  xlsx: { family: "zip", part: "xl/workbook.xml" },
  ppt: { family: "cfb", streams: ["powerpoint document"] },
  doc: { family: "cfb", streams: ["worddocument"] },
  xls: { family: "cfb", streams: ["workbook", "book"] },
  pdf: { family: "pdf" },
  jpg: { family: "jpg" },
  png: { family: "png" },
  gif: { family: "gif" },
  webp: { family: "webp" },
  heic: { family: "heic" },
  mp4: { family: "mp4" },
  mov: { family: "mov" },
  webm: { family: "webm" },
  txt: { family: null },
  md: { family: null },
  csv: { family: null },
};

/** The verdict shape shared by cfb.ts, pdf-scan.ts and this file; `reason` names the rule for logs and tests. */
export type Check = { ok: true } | { ok: false; error: Refusal; reason: string };
export const OK: Check = { ok: true };
export const fail = (error: Refusal, reason: string): Check => ({ ok: false, error, reason });

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

/** Major brands that open as HEIC or HEIF stills and sequences. */
const HEIC_BRANDS: ReadonlySet<string> = new Set([
  ...["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"],
  ...["mif1", "msf1"],
]);
const MOV_BRAND = "qt  ";
const MP4_BRANDS: ReadonlySet<string> = new Set([
  ...["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp71", "avc1", "dash"],
  ...["M4V ", "M4VP", "3gp4", "3gp5", "XAVC"],
]);
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
/** The EBML header is a few dozen bytes; the DocType element sits inside it. */
const EBML_SCAN_BYTES = 64;
/** EBML DocType element (0x4282), a 4 byte value, then "webm". */
const WEBM_DOCTYPE = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];

const hasSequence = (b: Uint8Array, seq: number[], from = 0, to = b.length): boolean => {
  for (let i = from; i + seq.length <= to; i++) if (seq.every((s, j) => b[i + j] === s)) return true;
  return false;
};

const hasMagic = (b: Uint8Array, magic: number[]) => b.length >= magic.length && magic.every((m, i) => b[i] === m);

/**
 * What the first bytes say the file is, or null: the one place a magic number or brand is read. WebM and Matroska
 * share a header, so only the `webm` DocType passes; any other `ftyp` brand is none.
 */
export function detect(head: Uint8Array): Family | null {
  if (startsWith(head, "PK\x03\x04")) return "zip";
  if (hasMagic(head, CFB_MAGIC)) return "cfb";
  if (startsWith(head, "%PDF-")) return "pdf";
  if (hasMagic(head, JPEG_MAGIC)) return "jpg";
  if (hasMagic(head, PNG_MAGIC)) return "png";
  if (startsWith(head, "GIF87a") || startsWith(head, "GIF89a")) return "gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "webp";
  const brand = majorBrand(head);
  if (brand === MOV_BRAND) return "mov";
  if (brand !== null && MP4_BRANDS.has(brand)) return "mp4";
  if (brand !== null && HEIC_BRANDS.has(brand)) return "heic";
  if (hasMagic(head, EBML_MAGIC) && hasSequence(head, WEBM_DOCTYPE, 4, EBML_SCAN_BYTES)) return "webm";
  return null;
}

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Plain text: at most 5 MB, valid UTF-8 (a leading byte order mark is allowed) and no NUL. */
export function checkText(bytes: Uint8Array): Check {
  if (bytes.length > MAX_TEXT_BYTES) return fail("too_large", "text over 5 MB");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? fail("bad_structure", "NUL in text") : OK;
  } catch {
    return fail("bad_structure", "not UTF-8");
  }
}
