import type { OpenMode } from "../../../shared/protocol.ts";
import { fail } from "../../http.ts";
import { hostAllowed } from "../file-source/graph.ts";
import type { Resolved } from "../file-source/index.ts";
import type { OpenPath } from "./index.ts";
import type { StreamOpenPath } from "./stream.ts";

/**
 * 302 to the source's own pre-authenticated URL, so bloop never carries the bytes. The only Location this
 * ever sends is a source URL whose host passed the allowlist here too: an open redirect is impossible
 * because nothing from the request reaches it (OPEN-04). A source with no URL (mock, guest) streams.
 */
export class RedirectOpenPath implements OpenPath {
  readonly mode = "redirect";

  constructor(
    private readonly downloadHosts: readonly string[],
    private readonly stream: StreamOpenPath,
  ) {}

  async serve(request: Request, file: Resolved, purpose: OpenMode): Promise<Response> {
    if (file.url === null) return this.stream.serve(request, file, purpose);
    if (!hostAllowed(file.url, this.downloadHosts)) return fail("upstream_failed");
    return new Response(null, { status: 302, headers: { Location: file.url } });
  }
}
