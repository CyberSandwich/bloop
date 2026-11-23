import type { FileType, OpenMode } from "../../../shared/protocol.ts";
import { type Policy, withPolicy } from "../../headers.ts";
import type { Resolved } from "../file-source/index.ts";
import { type OpenPath, sourceFailure } from "./index.ts";

const CONTENT_TYPES: Record<FileType, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

/** Only the PDF view is shown inline; every other purpose is an attachment, whatever the type. */
export const policyFor = (purpose: OpenMode): Policy => (purpose === "pdf" ? "file-pdf" : "file-pptx");

// Declared here because the Node tsconfig (tests) has no Workers types; undefined outside the Workers runtime.
declare const FixedLengthStream: (new (length: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;

/** The runtime drops a Content-Length set by hand on a stream body; a FixedLengthStream keeps it. Node (unit tests) has none. */
function sized(stream: ReadableStream<Uint8Array>, length: number | null): ReadableStream<Uint8Array> {
  if (length === null || typeof FixedLengthStream === "undefined") return stream;
  const fixed = new FixedLengthStream(length);
  stream.pipeTo(fixed.writable).catch(() => {}); // a short source errors the response, which is the right outcome
  return fixed.readable;
}

/** Carries the bytes through the Worker, unstored. Also the answer whenever a source has no URL to hand out. */
export class StreamOpenPath implements OpenPath {
  readonly mode = "stream";

  async serve(request: Request, file: Resolved, purpose: OpenMode): Promise<Response> {
    let body: ReadableStream<Uint8Array> | null = null;
    let length = file.size;
    // HEAD answers from the metadata: opening the stream would cost an upstream call for nothing.
    if (request.method !== "HEAD") {
      const opened = await file.body();
      if (!opened.ok) return sourceFailure(opened.error);
      length = opened.length ?? length;
      body = sized(opened.stream, length);
    }
    const headers: Record<string, string> = { "Content-Type": CONTENT_TYPES[file.type] };
    if (length !== null) headers["Content-Length"] = String(length);
    return withPolicy(new Response(body, { status: 200, headers }), policyFor(purpose));
  }
}
