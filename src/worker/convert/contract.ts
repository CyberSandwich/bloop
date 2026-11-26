// The conversion container's job contract as the Worker reads it. container/README.md owns it; a drift test
// (test/unit/convert-contract.test.ts) fails when the two differ. Pure: no Workers types.
import { z } from "zod";
import { MAX_PIXELS } from "../../shared/limits.ts";

export const KINDS = ["deck", "doc", "sheet", "pdf", "video", "image"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_BY_EXT = {
  pptx: "deck",
  ppsx: "deck",
  ppt: "deck",
  pps: "deck",
  odp: "deck",
  docx: "doc",
  doc: "doc",
  odt: "doc",
  rtf: "doc",
  xlsx: "sheet",
  xls: "sheet",
  ods: "sheet",
  pdf: "pdf",
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  heic: "image",
  heif: "image",
} as const satisfies Record<string, Kind>;
export type Ext = keyof typeof KIND_BY_EXT;

export const isExt = (ext: string): ext is Ext => Object.hasOwn(KIND_BY_EXT, ext);
/** The kinds that render to pages (a PDF, slide images, notes). */
export const isDocument = (kind: Kind): boolean => kind !== "video" && kind !== "image";
/** Legacy formats the container converts twice (office to PDF, then to pptx for notes and fonts). */
export const SECOND_CONVERT_EXTS: readonly string[] = ["ppt", "pps", "odp"];

export const STAGES = ["inspect", "convert", "rasterize", "video", "heic", "done"] as const;
export type ContainerStage = (typeof STAGES)[number];

/** Seconds, the container's per-stage defaults; video is the ceiling its own budget stays under. */
export const STAGE_TIMEOUT_S = { inspect: 30, convert: 180, rasterize: 500, video: 1440, heic: 60 } as const;

export const CONTAINER_ERRORS = [
  "bad_magic",
  "bad_archive",
  "bomb",
  "too_large",
  "bad_page_size",
  "bad_media",
  "convert_failed",
  "output_invalid",
  "timeout",
  "upload_failed",
  "internal",
] as const;
export type ContainerError = (typeof CONTAINER_ERRORS)[number];

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
export const OUTPUT_CAPS = {
  webp: 40 * MIB,
  jpeg: 40 * MIB,
  pdf: GIB,
  mp4: 4 * GIB,
  json: 5 * MIB,
  total: 8 * GIB,
} as const;
export const CHUNK_BYTES = 64 * MIB;
export const MAX_CHUNKS = 100_000;

/** The widths the container renders by default; `BLOOP_WIDTHS` overrides them. */
export const FULL_WIDTHS: readonly number[] = [3840, 1920, 480];

/** The three JSON files: read whole, so their cap is `OUTPUT_CAPS.json`. */
export const JSON_FILES = ["slides.json", "notes.json", "meta.json"] as const;

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const int = z.number().int().nonnegative();

export const statusSchema = z.looseObject({
  state: z.enum(["idle", "running", "done", "failed"]),
  stage: z.enum(STAGES).nullable(),
  pct: z.number().min(0).max(100),
  error: z.enum(CONTAINER_ERRORS).nullable(),
  pages: z.strictObject({ done: int, total: int }).nullable(),
  ready: z.array(z.string().max(64)).max(20),
});
export type ContainerStatus = z.infer<typeof statusSchema>;

export const manifestSchema = z.strictObject({
  v: z.literal(1),
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  kind: z.enum(KINDS),
  pages: z.strictObject({ total: int, rendered: int }).nullable(),
  groups: z.record(z.string(), z.strictObject({ ok: z.boolean(), error: z.string().max(64).optional() })),
  files: z
    .array(z.strictObject({ path: z.string().max(64), size: int, sha256: sha, type: z.string().max(100) }))
    .max(2000),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const slidesInSchema = z.strictObject({
  v: z.literal(1),
  widths: z.array(z.number().int().positive().max(4095)).min(1).max(6),
  pages: z.array(
    z.strictObject({ n: z.number().int().positive(), w: z.number().int().positive(), h: z.number().int().positive() }),
  ),
  motion: z.boolean(),
  media: z.boolean(),
});
export type SlidesIn = z.infer<typeof slidesInSchema>;

export const NOTE_CHARS = 4000;
/** C0 controls and DEL, except a newline. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f]/;
export const notesSchema = z.strictObject({
  v: z.literal(1),
  notes: z.array(
    z.strictObject({
      n: z.number().int().positive(),
      text: z
        .string()
        .max(NOTE_CHARS)
        .refine((t) => !CONTROLS.test(t), "control character"),
    }),
  ),
});
export type NotesIn = z.infer<typeof notesSchema>;

const name = z
  .string()
  .max(100)
  .refine((t) => !CONTROLS.test(t) && !t.includes("\n"), "control character");
export const metaSchema = z.strictObject({
  v: z.literal(1),
  sha256: sha,
  kind: z.enum(KINDS),
  fontsMissing: z.array(name).max(50).optional(),
  video: z
    .strictObject({
      w: z.number().int().positive().max(8192),
      h: z.number().int().positive().max(8192),
      durationMs: int.max(4 * 3600 * 1000),
    })
    .optional(),
  image: z
    .strictObject({ w: z.number().int().positive(), h: z.number().int().positive() })
    .refine((i) => i.w * i.h <= MAX_PIXELS)
    .optional(),
});
export type Meta = z.infer<typeof metaSchema>;

/** The `POST /job/start` body. */
export interface StartBody {
  jobId: string;
  ext: string;
  size: number;
  sha256: string;
  chunks: number;
}
