// Stand-in for FileSource.resolve until the file-source module lands: two fixed demo ids, nothing else.
import type { FileRef } from "../machine.ts";

const STUB_FILES: Readonly<Record<string, FileRef>> = {
  "demo-deck": { source: "mock", ref: "demo-deck", name: "Sample deck.pptx", type: "pptx" },
  "demo-pdf": { source: "mock", ref: "demo-pdf", name: "Sample slides.pdf", type: "pdf" },
};

export const resolveStubFile = (fileId: string): FileRef | null =>
  Object.hasOwn(STUB_FILES, fileId) ? (STUB_FILES[fileId] ?? null) : null;
