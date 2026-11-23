import type { OpenPath } from "./index.ts";
import { RedirectOpenPath } from "./redirect.ts";
import { StreamOpenPath } from "./stream.ts";

export function openPathFor(mode: "redirect" | "stream", downloadHosts: readonly string[]): OpenPath {
  const stream = new StreamOpenPath();
  return mode === "stream" ? stream : new RedirectOpenPath(downloadHosts, stream);
}
