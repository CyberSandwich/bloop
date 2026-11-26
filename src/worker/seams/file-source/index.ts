// FileSource seam (docs/interfaces.md section 3). The route layer talks to this interface only.
import type { FileEntry, FileType, Mode, SourceError } from "../../../shared/protocol.ts";
import type { Pinned } from "../../library/store.ts";
import type { ByteRange } from "../open-path/range.ts";

export interface SourceContext {
  mode: Mode;
  userId: string | null;
  /** Graph only: the folder listing is limited to. Null lists the drive root. */
  folderId: string | null;
  /** Graph only: returns a fresh access token from the vault, refreshing with compare-and-swap. */
  accessToken(): Promise<{ ok: true; token: string } | { ok: false; error: SourceError }>;
  /**
   * Library only: the phone session the fetch is on behalf of, so a signed-out phone stops serving. `null` is for the
   * `/p/` preview fetch, which carries no session; left out, the library source finds nothing.
   */
  pinned?: Pinned | null;
}

export interface Resolved {
  name: string;
  type: FileType;
  size: number | null;
  /** Pre-authenticated URL, host already checked against GRAPH_DOWNLOAD_HOSTS. Null when only streaming is possible. */
  url: string | null;
  /** Streams the bytes, or only `range` when given (the length is then the range's); a source with no ranges ignores it. Always available. */
  body(
    range?: ByteRange,
  ): Promise<
    { ok: true; stream: ReadableStream<Uint8Array>; length: number | null } | { ok: false; error: SourceError }
  >;
}

export interface FileSource {
  readonly kind: "mock" | "graph" | "library";
  /** At most `limit` decks, newest edit first. Never .pptm or macro-enabled types. */
  listRecent(
    ctx: SourceContext,
    limit: number,
  ): Promise<{ ok: true; files: FileEntry[] } | { ok: false; error: SourceError }>;
  /** Called at fetch time (the /f/ request), never at approve time: download URLs expire in minutes. */
  resolve(
    ctx: SourceContext,
    fileId: string,
  ): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError }>;
  /** A PDF rendition, for the last fallback. Graph converts it; mock serves a fixture. */
  resolvePdf(
    ctx: SourceContext,
    fileId: string,
  ): Promise<{ ok: true; file: Resolved } | { ok: false; error: SourceError | "pdf_unavailable" }>;
  /**
   * Speaker notes, one entry per page, "" for a page with none; `[]` for a file that has none. Phone-only: the route
   * answers the pairing's pid and nothing else carries them (NOTES-01). A source with no notes leaves this out.
   */
  notes?(
    ctx: SourceContext,
    fileId: string,
  ): Promise<{ ok: true; notes: string[] } | { ok: false; error: SourceError }>;
}
