// The output validator and pack builder (CONV-04, CONV-10): everything the container claims is checked again here,
// because a declared size or hash is a claim and never a measure. No Workers types: node-testable.
import { majorBrand } from "../seams/guest-drop/bytes.ts";
import {
  isDocument,
  KIND_BY_EXT,
  type Kind,
  type Manifest,
  manifestSchema,
  metaSchema,
  notesSchema,
  OUTPUT_CAPS,
  type SlidesIn,
  slidesInSchema,
} from "./contract.ts";
import type { Profile } from "./profile.ts";

export class OutputError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

export type Group = "slides" | "pdf" | "notes" | "media" | "image";
export const GROUPS_BY_KIND = (kind: Kind): readonly Group[] =>
  kind === "video" ? ["media"] : kind === "image" ? ["image"] : ["slides", "pdf", "notes"];

// ---------------------------------------------------------------- the path grammar (anchored, ASCII only)

export type PathInfo =
  | { type: "pdf" }
  | { type: "json"; name: "slides.json" | "notes.json" | "meta.json" }
  | { type: "thumb" }
  | { type: "page"; n: number; w: number }
  | { type: "mp4" }
  | { type: "jpeg" };

const PAGE = /^s\/([1-9][0-9]{0,5})\/([1-9][0-9]{0,4})\.webp$/;

export function parsePath(path: string): PathInfo | null {
  switch (path) {
    case "doc.pdf":
      return { type: "pdf" };
    case "slides.json":
    case "notes.json":
    case "meta.json":
      return { type: "json", name: path };
    case "t.webp":
      return { type: "thumb" };
    case "m/0.mp4":
    case "m/720.mp4":
      return { type: "mp4" };
    case "i/1920.jpg":
      return { type: "jpeg" };
  }
  const m = PAGE.exec(path);
  return m ? { type: "page", n: Number(m[1]), w: Number(m[2]) } : null;
}

const capOf = (info: PathInfo): number =>
  info.type === "pdf"
    ? OUTPUT_CAPS.pdf
    : info.type === "mp4"
      ? OUTPUT_CAPS.mp4
      : info.type === "json"
        ? OUTPUT_CAPS.json
        : info.type === "jpeg"
          ? OUTPUT_CAPS.jpeg
          : OUTPUT_CAPS.webp;

export function groupOf(info: PathInfo, kind: Kind): Group | null {
  switch (info.type) {
    case "pdf":
      return "pdf";
    case "page":
      return "slides";
    case "mp4":
      return "media";
    case "jpeg":
      return "image";
    case "thumb":
      return kind === "video" ? "media" : kind === "image" ? "image" : "slides";
    case "json":
      return info.name === "slides.json" ? "slides" : info.name === "notes.json" ? "notes" : null;
  }
}

/** The exact set of paths a manifest may list, given the groups it says passed. */
export function expectedPaths(
  rendered: number,
  widths: readonly number[],
  passed: ReadonlySet<Group>,
  preview = false,
): Set<string> {
  const out = new Set<string>(["meta.json"]);
  if (passed.has("pdf")) out.add("doc.pdf");
  if (passed.has("notes")) out.add("notes.json");
  if (passed.has("slides")) {
    out.add("t.webp").add("slides.json");
    for (let n = 1; n <= rendered; n++) for (const w of widths) out.add(`s/${n}/${w}.webp`);
  }
  if (passed.has("media")) out.add(preview ? "m/720.mp4" : "m/0.mp4").add("t.webp");
  if (passed.has("image")) out.add("i/1920.jpg").add("t.webp");
  return out;
}

// ---------------------------------------------------------------- the manifest

export interface Piece {
  size: number;
  sha256: string;
}

export interface CheckedManifest {
  manifest: Manifest;
  /** Groups the container says passed. */
  passed: Set<Group>;
  rendered: number;
  total: number;
  pieces: Map<string, Piece>;
  /** The video's mp4 is the 720p, not the full encode. */
  preview: boolean;
}

export type ManifestResult = { ok: true; checked: CheckedManifest } | { ok: false; reason: string };

const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function checkManifest(raw: unknown, ctx: { jobId: string; ext: string; profile: Profile }): ManifestResult {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return bad("manifest_shape");
  const m = parsed.data;
  const kind = KIND_BY_EXT[ctx.ext as keyof typeof KIND_BY_EXT];
  if (m.jobId !== ctx.jobId) return bad("job_id");
  if (!kind || m.kind !== kind) return bad("kind");
  const doc = isDocument(kind);
  if (doc !== (m.pages !== null)) return bad("pages_presence");
  const rendered = m.pages?.rendered ?? 0;
  const total = m.pages?.total ?? 0;
  if (rendered > ctx.profile.maxPages || total < rendered) return bad("pages_range");

  const names = GROUPS_BY_KIND(kind);
  const keys = Object.keys(m.groups);
  if (keys.length !== names.length || !names.every((g) => Object.hasOwn(m.groups, g))) return bad("groups");
  const passed = new Set(names.filter((g) => m.groups[g]?.ok === true));

  if (m.files.length > 3 * rendered + 6) return bad("too_many_files");
  const pieces = new Map<string, Piece>();
  let sum = 0;
  for (const f of m.files) {
    if (pieces.has(f.path)) return bad("duplicate_path");
    const info = parsePath(f.path);
    if (!info) return bad("path_grammar");
    if (info.type === "page" && (info.n > rendered || !ctx.profile.widths.includes(info.w))) return bad("path_range");
    if (f.size > capOf(info)) return bad("file_cap");
    sum += f.size;
    pieces.set(f.path, { size: f.size, sha256: f.sha256 });
  }
  if (sum > ctx.profile.totalBytes) return bad("total_cap");

  // A video's one mp4 is the full encode (m/0.mp4) or, when the full encode did not finish, the 720p (m/720.mp4).
  const preview = kind === "video" && pieces.has("m/720.mp4");
  const expected = expectedPaths(rendered, ctx.profile.widths, passed, preview);
  if (expected.size !== pieces.size || ![...pieces.keys()].every((p) => expected.has(p))) return bad("path_set");
  return { ok: true, checked: { manifest: m, passed, rendered, total, pieces, preview } };
}

// ---------------------------------------------------------------- the three JSON files

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.length > OUTPUT_CAPS.json) throw new OutputError("json", "too_big");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new OutputError("json", "not_json");
  }
}

/** The container's slides.json, checked against the manifest's counts and the profile. It is input, never stored. */
export function checkSlides(bytes: Uint8Array, ctx: { rendered: number; profile: Profile }): SlidesIn {
  const r = slidesInSchema.safeParse(parseJson(bytes));
  if (!r.success) throw new OutputError("slides.json", "shape");
  const s = r.data;
  if (s.pages.length !== ctx.rendered) throw new OutputError("slides.json", "page_count");
  if (s.widths.join() !== ctx.profile.widths.join()) throw new OutputError("slides.json", "widths");
  const widest = ctx.profile.widths[0];
  s.pages.forEach((p, i) => {
    if (p.n !== i + 1 || p.w !== widest) throw new OutputError("slides.json", "page_entry");
  });
  return s;
}

/** The note texts, in page order, each page at most once. */
export function checkNotes(bytes: Uint8Array, ctx: { rendered: number }): { n: number; text: string }[] {
  const r = notesSchema.safeParse(parseJson(bytes));
  if (!r.success) throw new OutputError("notes.json", "shape");
  let last = 0;
  for (const note of r.data.notes) {
    if (note.n <= last || note.n > ctx.rendered) throw new OutputError("notes.json", "order");
    last = note.n;
  }
  return r.data.notes;
}

export function checkMeta(bytes: Uint8Array, ctx: { kind: Kind }) {
  const r = metaSchema.safeParse(parseJson(bytes));
  if (!r.success) throw new OutputError("meta.json", "shape");
  const m = r.data;
  if (m.kind !== ctx.kind) throw new OutputError("meta.json", "kind");
  if ((ctx.kind === "video") !== (m.video !== undefined)) throw new OutputError("meta.json", "video");
  if ((ctx.kind === "image") !== (m.image !== undefined)) throw new OutputError("meta.json", "image");
  return m;
}

// ---------------------------------------------------------------- per-piece streaming guard

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024;
const PDF_BANNED = ["/JavaScript", "/Launch", "/EmbeddedFile"];
const PDF_CARRY = Math.max(...PDF_BANNED.map((s) => s.length)) - 1;
const MP4_BRANDS = ["isom", "iso2", "mp41", "mp42", "avc1"];
const latin1 = new TextDecoder("latin1");

const u32le = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const tag = (b: Uint8Array, at: number): string => latin1.decode(b.subarray(at, at + 4));

/** Width and height of a WebP from its first chunk (VP8, VP8L or VP8X), or null. */
export function webpSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 30 || tag(b, 0) !== "RIFF" || tag(b, 8) !== "WEBP") return null;
  switch (tag(b, 12)) {
    case "VP8X":
      return {
        w: 1 + ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16)),
        h: 1 + ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16)),
      };
    case "VP8L": {
      if (b[20] !== 0x2f) return null;
      const bits = u32le(b, 21);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) };
    }
    case "VP8 ":
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { w: (b[26] ?? 0) | (((b[27] ?? 0) & 0x3f) << 8), h: (b[28] ?? 0) | (((b[29] ?? 0) & 0x3f) << 8) };
    default:
      return null;
  }
}

/** Width of a baseline or progressive JPEG from its first SOF marker within `b`, or null. */
function jpegWidth(b: Uint8Array): number | null {
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xc0 || marker === 0xc2) return u16be(b, i + 7);
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

export interface PieceCtx {
  /** The checked page sizes of slides.json, for the height of each rendition. */
  pages?: readonly { w: number; h: number }[];
  /** Called with the first check that fails. */
  report?: (e: OutputError) => void;
}

type Check = (head: Uint8Array, tail: Uint8Array, size: number) => void;

function checkFor(path: string, ctx: PieceCtx): Check {
  const info = parsePath(path);
  const fail = (reason: string): never => {
    throw new OutputError(path, reason);
  };
  switch (info?.type) {
    case "page":
    case "thumb":
      return (head, _tail, size) => {
        const dim = webpSize(head);
        if (!dim || u32le(head, 4) !== size - 8) return fail("webp");
        if (info.type === "thumb") return dim.w > 480 ? fail("thumb_width") : undefined;
        if (dim.w !== info.w) return fail("webp_width");
        const page = ctx.pages?.[info.n - 1];
        if (!page || Math.abs(dim.h - Math.round((info.w * page.h) / page.w)) > 1) return fail("webp_height");
      };
    case "jpeg":
      return (head, tail) => {
        const w = jpegWidth(head);
        if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return fail("jpeg_start");
        if (tail[tail.length - 2] !== 0xff || tail[tail.length - 1] !== 0xd9) return fail("jpeg_end");
        if (w === null || w > 1920) return fail("jpeg_width");
      };
    case "pdf":
      return (head, tail) => {
        if (latin1.decode(head.subarray(0, 5)) !== "%PDF-") return fail("pdf_start");
        if (!latin1.decode(tail).includes("%%EOF")) return fail("pdf_end");
      };
    case "mp4":
      return (head) => {
        const brand = majorBrand(head);
        if (!brand || !MP4_BRANDS.includes(brand)) return fail("mp4_ftyp");
      };
    default:
      return () => undefined;
  }
}

export interface Hasher {
  write(chunk: Uint8Array): Promise<void>;
  hex(): Promise<string>;
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));

/** SHA-256 over a stream: the platform's `DigestStream` in a Worker, a buffered digest elsewhere (tests). */
export function sha256Hasher(): Hasher {
  const Digest = (
    crypto as unknown as {
      DigestStream?: new (alg: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
    }
  ).DigestStream;
  if (Digest) {
    const ds = new Digest("SHA-256");
    const w = ds.getWriter();
    return {
      write: (chunk) => w.write(chunk),
      hex: async () => {
        await w.close();
        return toHex(await ds.digest);
      },
    };
  }
  const parts: Uint8Array[] = [];
  return {
    write: async (chunk) => {
      parts.push(chunk.slice());
    },
    hex: async () =>
      toHex(await crypto.subtle.digest("SHA-256", parts.reduce(concat, new Uint8Array(0)) as Uint8Array<ArrayBuffer>)),
  };
}

/**
 * A pass-through that counts bytes (more or fewer than declared is an error), hashes them, scans a PDF for active
 * content across chunk edges, and checks the head and tail by path. A failure errors the stream, so a put reading
 * it rejects and stores nothing.
 */
export function pieceGuard(
  path: string,
  declared: Piece,
  ctx: PieceCtx = {},
  hasher: () => Hasher = sha256Hasher,
): TransformStream<Uint8Array, Uint8Array> {
  const check = checkFor(path, ctx);
  const isPdf = path === "doc.pdf";
  const hash = hasher();
  let count = 0;
  let head: Uint8Array = new Uint8Array(0);
  let tail: Uint8Array = new Uint8Array(0);
  let carry = "";
  // An OutputError is reported before it errors the stream: a put that reads the stream rejects with whatever the
  // platform makes of it, so the caller learns "the file was bad" from `report`, not from the rejection's type.
  const reported = async (step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (e) {
      if (e instanceof OutputError) ctx.report?.(e);
      throw e;
    }
  };
  return new TransformStream({
    transform: (chunk, controller) =>
      reported(async () => {
        count += chunk.length;
        if (count > declared.size) throw new OutputError(path, "longer_than_declared");
        if (head.length < HEAD_BYTES) head = concat(head, chunk.subarray(0, HEAD_BYTES - head.length));
        tail = chunk.length >= TAIL_BYTES ? chunk.slice(-TAIL_BYTES) : concat(tail, chunk).slice(-TAIL_BYTES);
        if (isPdf) {
          const text = carry + latin1.decode(chunk);
          for (const word of PDF_BANNED) if (text.includes(word)) throw new OutputError(path, "pdf_active_content");
          carry = text.slice(-PDF_CARRY);
        }
        await hash.write(chunk);
        controller.enqueue(chunk);
      }),
    flush: () =>
      reported(async () => {
        if (count !== declared.size) throw new OutputError(path, "shorter_than_declared");
        if ((await hash.hex()) !== declared.sha256) throw new OutputError(path, "sha256");
        check(head, tail, count);
      }),
  });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Reads a whole stream, which must stay under `limit` bytes. */
export async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  let out: Uint8Array = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    if (out.length + value.length > limit) {
      await reader.cancel();
      throw new OutputError("stream", "over_limit");
    }
    out = concat(out, value);
  }
}

// ---------------------------------------------------------------- slide packs (F7)

export interface PackPiece {
  n: number;
  path: string;
  start: number;
  length: number;
  sha256: string;
}
export interface PackPlan {
  w: number;
  size: number;
  pieces: PackPiece[];
}

/** One pack per width: page 1 to `rendered` in order; offsets come from the checked sizes, never the container. */
export function packPlan(rendered: number, widths: readonly number[], pieces: ReadonlyMap<string, Piece>): PackPlan[] {
  return widths.map((w) => {
    let start = 0;
    const list: PackPiece[] = [];
    for (let n = 1; n <= rendered; n++) {
      const path = `s/${n}/${w}.webp`;
      const p = pieces.get(path);
      if (!p) throw new OutputError(path, "missing");
      list.push({ n, path, start, length: p.size, sha256: p.sha256 });
      start += p.size;
    }
    return { w, size: start, pieces: list };
  });
}

/** What the viewer reads: built only from checked values. */
export interface SlidesOut {
  v: 2;
  total: number;
  rendered: number;
  motion: boolean;
  media: boolean;
  pages: { n: number; w: number; h: number }[];
  packs: Record<string, { size: number }>;
  offsets: Record<string, [number, number][]>;
}

export function buildSlidesJson(
  slides: SlidesIn,
  counts: { total: number; rendered: number },
  plans: readonly PackPlan[],
): SlidesOut {
  return {
    v: 2,
    total: counts.total,
    rendered: counts.rendered,
    motion: slides.motion,
    media: slides.media,
    pages: slides.pages.map(({ n, w, h }) => ({ n, w, h })),
    packs: Object.fromEntries(plans.map((p) => [String(p.w), { size: p.size }])),
    offsets: Object.fromEntries(
      plans.map((p) => [String(p.w), p.pieces.map((x): [number, number] => [x.start, x.length])]),
    ),
  };
}

// ---------------------------------------------------------------- groups and the stored set

export type GroupVerdict = { ok: true; groups: Group[] } | { ok: false };

/**
 * A document is done if its slides or its PDF passed; a video or an image needs its one group. Notes alone are
 * never enough, and a failed notes group only clears `has_notes`.
 */
export function decideGroups(kind: Kind, passed: ReadonlySet<Group>): GroupVerdict {
  const groups = GROUPS_BY_KIND(kind).filter((g) => passed.has(g));
  const live = isDocument(kind) ? passed.has("slides") || passed.has("pdf") : groups.length === 1;
  return live ? { ok: true, groups } : { ok: false };
}

/** The relative names the Worker stores for a group. Notes live under `n/`, outside the bundle. */
export function storedPaths(group: Group, widths: readonly number[]): string[] {
  switch (group) {
    case "slides":
      return ["t.webp", ...widths.map((w) => `s/1/${w}.webp`), ...widths.map((w) => `s/${w}.pack`), "slides.json"];
    case "pdf":
      return ["doc.pdf"];
    case "notes":
      return ["notes.json"];
    case "media":
      return ["m/0.mp4", "m/720.mp4", "t.webp"];
    case "image":
      return ["i/1920.jpg", "t.webp"];
  }
}

/** The stored-name grammar: the only names `keys.ts` will turn into a key. */
export const STORED =
  /^(?:t\.webp|slides\.json|doc\.pdf|notes\.json|m\/(?:0|720)\.mp4|i\/1920\.jpg|s\/[1-9][0-9]{0,4}\.pack|s\/1\/[1-9][0-9]{0,4}\.webp)$/;
