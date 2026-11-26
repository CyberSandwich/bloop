// The library as a FileSource (docs/library.md section 5): what a screen lists and fetches is exactly what the serving
// predicate allows (ADR 0015), checked at fetch time against the owner's row, never from a cached listing.
import type { FileEntry, FileType, SourceError } from "../../../shared/protocol.ts";
import type { LibraryBucket } from "../../library/bucket.ts";
import { type LibDb, type Servable, servableById, servableRecent } from "../../library/store.ts";
import type { FileSource, Resolved, SourceContext } from "./index.ts";

export interface LibrarySourceEnv {
  DB: LibDb;
  LIBRARY: LibraryBucket;
}

// transitional: U: the type guard becomes `ext in FORMATS` (guest-drop/formats.ts) once U's formats land
const isFileType = (ext: string): ext is FileType => ["pptx", "pdf", "jpg", "png", "mp4", "mov"].includes(ext);

const entryOf = (s: Servable): FileEntry | null =>
  isFileType(s.ext)
    ? { kind: "file", id: s.id, name: s.name, type: s.ext, modifiedAt: s.updatedAt, size: s.bytes }
    : null;

/** The row's own size and the bucket's disagree only when the object is gone or half written; neither is served. */
function resolvedOf(env: LibrarySourceEnv, s: Servable, type: FileType): Resolved {
  return {
    name: s.name,
    type,
    size: s.bytes,
    url: null,
    async body(range) {
      const object = await env.LIBRARY.get(s.r2Key, range ? { range } : undefined);
      if (!object || object.size !== s.bytes) return { ok: false, error: "file_not_found" };
      return { ok: true, stream: object.body, length: range ? range.length : s.bytes };
    },
  };
}

export class LibraryFileSource implements FileSource {
  readonly kind = "library";
  constructor(private readonly env: LibrarySourceEnv) {}

  async listRecent(ctx: SourceContext, limit: number) {
    if (ctx.userId === null || ctx.pinned === undefined) return { ok: false, error: "auth_required" } as const;
    const rows = await servableRecent(this.env.DB, ctx.userId, ctx.pinned, limit);
    const files = rows.flatMap((s) => entryOf(s) ?? []);
    return files.length === 0 ? ({ ok: false, error: "no_files" } as const) : ({ ok: true, files } as const);
  }

  async resolve(ctx: SourceContext, fileId: string) {
    const found = await this.find(ctx, fileId);
    if (!found.ok) return found;
    return { ok: true, file: resolvedOf(this.env, found.row, found.type) } as const;
  }

  /** A PDF is its own rendition; the library keeps no other (the converter's bundle is not a PDF). */
  async resolvePdf(ctx: SourceContext, fileId: string) {
    const found = await this.find(ctx, fileId);
    if (!found.ok) return found;
    if (found.type !== "pdf") return { ok: false, error: "pdf_unavailable" } as const;
    return { ok: true, file: resolvedOf(this.env, found.row, found.type) } as const;
  }

  private async find(
    ctx: SourceContext,
    fileId: string,
  ): Promise<{ ok: true; row: Servable; type: FileType } | { ok: false; error: SourceError }> {
    if (ctx.userId === null || ctx.pinned === undefined) return { ok: false, error: "auth_required" };
    const row = await servableById(this.env.DB, ctx.userId, fileId, ctx.pinned);
    if (!row) return { ok: false, error: "file_not_found" };
    return isFileType(row.ext) ? { ok: true, row, type: row.ext } : { ok: false, error: "file_type_refused" };
  }
}
