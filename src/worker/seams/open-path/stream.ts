import type { FileType, OpenMode } from "../../../shared/protocol.ts";
import { type Policy, withPolicy } from "../../headers.ts";
import type { Resolved } from "../file-source/index.ts";
import { type OpenPath, sourceFailure } from "./index.ts";
import { type ByteRange, parseRange } from "./range.ts";

/** The types answered with `Accept-Ranges` and 206. */
const RANGED: ReadonlySet<FileType> = new Set(["mp4", "mov"]);

/** Fixed per type, never from the bytes or the name: with `nosniff`, an image cannot run as anything else (IMG-01). */
export const CONTENT_TYPES: Record<FileType, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  // A .mov is served as MP4 too: the bytes decide nothing about the served type.
  mp4: "video/mp4",
  mov: "video/mp4",
};

/** Only the PDF view and the image view are inline; every other purpose is an attachment, whatever the type. */
export const policyFor = (purpose: OpenMode): Policy =>
  purpose === "pdf" ? "file-pdf" : purpose === "view" ? "file-image" : "file-pptx";

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
    const policy = policyFor(purpose);
    const headers: Record<string, string> = { "Content-Type": CONTENT_TYPES[file.type] };
    // A video's player reads it in ranges; every other type is answered whole, whatever Range says.
    const ranged = RANGED.has(file.type) && file.size !== null;
    if (ranged) headers["Accept-Ranges"] = "bytes";
    let range: ByteRange | null = null;
    const asked = request.method === "GET" ? request.headers.get("Range") : null;
    if (ranged && asked !== null && file.size !== null) {
      const parsed = parseRange(asked, file.size);
      if (parsed === "unsatisfiable") {
        return withPolicy(
          new Response(null, {
            status: 416,
            headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${file.size}` },
          }),
          policy,
        );
      }
      range = parsed;
    }
    let body: ReadableStream<Uint8Array> | null = null;
    let length = range ? range.length : file.size;
    // HEAD answers from the metadata: opening the stream would cost an upstream call for nothing.
    if (request.method !== "HEAD") {
      const opened = await file.body(range ?? undefined);
      if (!opened.ok) return sourceFailure(opened.error);
      // A source that did not honor the range sent the whole body: say so with a 200, never a 206 that lies.
      if (range && opened.length !== range.length) {
        range = null;
        length = file.size;
      }
      length = opened.length ?? length;
      body = sized(opened.stream, length);
    }
    if (length !== null) headers["Content-Length"] = String(length);
    if (range && file.size !== null) {
      headers["Content-Range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`;
    }
    return withPolicy(new Response(body, { status: range ? 206 : 200, headers }), policy);
  }
}
