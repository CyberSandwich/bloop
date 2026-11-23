// OpenPath seam (docs/interfaces.md section 4): how an accepted /f/ request is answered. Link minting and
// the link rules are mode-independent and live in links.ts; this seam is only the answer. Switching
// OPEN_PATH_MODE swaps one class (ADR 0003); `openPathFor` in select.ts picks it.
import type { OpenMode, SourceError } from "../../../shared/protocol.ts";
import { fail } from "../../http.ts";
import type { Resolved } from "../file-source/index.ts";

export interface OpenPath {
  readonly mode: "redirect" | "stream";
  /** Serves an accepted GET or HEAD. The caller already ran the link rules and resolved the file. */
  serve(request: Request, file: Resolved, purpose: OpenMode): Promise<Response>;
}

/** What /f/ says about a source failure: a missing file stays 404, anything else is the upstream's fault. */
export const sourceFailure = (error: SourceError | "pdf_unavailable"): Response =>
  fail(error === "file_not_found" || error === "pdf_unavailable" ? error : "upstream_failed");
