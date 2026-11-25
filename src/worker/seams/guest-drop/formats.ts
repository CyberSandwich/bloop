// Pure format checks for the wider guest-drop types (DROP-14, DROP-15): OOXML relationships and content types,
// magic bytes and brands, plain text. Nothing here reads storage; callers pass the bytes or text they already hold.
import type { DropError } from "../../../shared/protocol.ts";
import { ZIP_LIMITS } from "./index.ts";

/** The verdict shape shared by cfb.ts, pdf-scan.ts and this file; `reason` names the rule for logs and tests. */
export type Check = { ok: true } | { ok: false; error: DropError; reason: string };
export const OK: Check = { ok: true };
export const fail = (error: DropError, reason: string): Check => ({ ok: false, error, reason });

const latin1 = new TextDecoder("latin1");
const ascii = (b: Uint8Array, at: number, length: number) => latin1.decode(b.subarray(at, at + length));

/** A macro project or ActiveX control in any Office package, whichever folder holds it. */
const MACRO_PARTS = [/(^|\/)vbaProject\.bin$/i, /(^|\/)activeX\//i];

export interface ExternalRelationship {
  type: string;
  target: string;
}

const attr = (tag: string, name: string): string =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
    .exec(tag)
    ?.slice(1)
    .find((v) => v !== undefined) ?? "";

/** The only relationship types that may leave the package: a link the reader clicks, never one a converter follows. */
const HYPERLINK_TYPES: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink",
]);

/** Every `TargetMode="External"` relationship in one `.rels` part, whatever its type. */
export function externalRelationships(relsXml: string): ExternalRelationship[] {
  const out: ExternalRelationship[] = [];
  for (const [tag] of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
    if (attr(tag, "TargetMode").toLowerCase() === "external")
      out.push({ type: attr(tag, "Type"), target: attr(tag, "Target") });
  }
  return out;
}

/**
 * An OOXML package (docx, xlsx, pptx and their macro twins) is refused when its content types name a macro-enabled
 * main part or a VBA project, when a macro or ActiveX part is present, or when a relationship other than a hyperlink
 * points outside the package. Judged on content, never on the extension: a `.docx` that carries a docm content type is a docm.
 */
export function checkOoxml(names: readonly string[], contentTypesXml: string, relsXml: readonly string[]): Check {
  if (ZIP_LIMITS.refusedContentTypes.some((p) => p.test(contentTypesXml)))
    return fail("macro_content", "macro content type");
  if (names.some((n) => MACRO_PARTS.some((p) => p.test(n)))) return fail("macro_content", "macro part");
  if (relsXml.some((x) => externalRelationships(x).some((r) => !HYPERLINK_TYPES.has(r.type))))
    return fail("bad_structure", "external relationship");
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
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp" && HEIC_BRANDS.has(ascii(head, 8, 4))) return "heic";
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
