// The default source: a demo account with sample decks. No sign-in, no network.
import type { FileEntry, FileType } from "../../../shared/protocol.ts";
import type { FileSource, Resolved, SourceContext } from "./index.ts";

export interface MockFixture {
  id: string;
  name: string;
  type: FileType;
  bytes: Uint8Array;
  /** How long before "now" the file counts as edited, so the list always looks recent. */
  editedMinutesAgo: number;
  /** The fixture served as this file's PDF rendition; null means none. A PDF fixture is its own rendition. */
  pdfId: string | null;
  /** Served only as another fixture's PDF rendition: never listed, and its own id resolves to nothing. */
  renditionOnly?: true;
}

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

export class MockFileSource implements FileSource {
  readonly kind = "mock";
  /** `byId` holds the listed fixtures only; a rendition is reached through `all` by its deck's `pdfId`. */
  private readonly byId: Map<string, MockFixture>;
  private readonly all: Map<string, MockFixture>;

  constructor(
    fixtures: readonly MockFixture[],
    private readonly now: () => number = Date.now,
  ) {
    this.byId = new Map(fixtures.filter((f) => !f.renditionOnly).map((f) => [f.id, f]));
    this.all = new Map(fixtures.map((f) => [f.id, f]));
  }

  async listRecent(_ctx: SourceContext, limit: number) {
    const now = this.now();
    const files: FileEntry[] = [...this.byId.values()]
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        modifiedAt: now - f.editedMinutesAgo * 60_000,
        size: f.bytes.length,
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, limit);
    return { ok: true, files } as const;
  }

  async resolve(_ctx: SourceContext, fileId: string) {
    const fixture = this.byId.get(fileId);
    return fixture
      ? ({ ok: true, file: toResolved(fixture) } as const)
      : ({ ok: false, error: "file_not_found" } as const);
  }

  async resolvePdf(_ctx: SourceContext, fileId: string) {
    const fixture = this.byId.get(fileId);
    if (!fixture) return { ok: false, error: "file_not_found" } as const;
    const pdf = fixture.type === "pdf" ? fixture : this.all.get(fixture.pdfId ?? "");
    return pdf ? ({ ok: true, file: toResolved(pdf) } as const) : ({ ok: false, error: "pdf_unavailable" } as const);
  }
}

const toResolved = (f: MockFixture): Resolved => ({
  name: f.name,
  type: f.type,
  size: f.bytes.length,
  url: null,
  body: async () => ({ ok: true, stream: streamOf(f.bytes), length: f.bytes.length }),
});
